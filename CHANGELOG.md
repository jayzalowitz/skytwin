All notable changes to SkyTwin will be documented in this file.

## [0.6.93.0] - 2026-06-29

### Added

- **`@skytwin/idle-miner` now ships `SnapshotFileStore` — a device-local, durable `FileIndexRepo` + `CursorRepo`.** `MinerOptions` requires both repos, but the package shipped no implementation, so every host had to write one before it could run the miner at all — a big part of why the idle-miner was never wired anywhere. `SnapshotFileStore` is the sensible default: an in-memory index backed by a single JSON snapshot under an injected directory, flushed atomically (write-temp + rename) on a debounce and on `close()`, so a crash can never corrupt the index (worst case: a re-scan of the last unflushed window). It is deliberately **device-local, not CockroachDB** — a file index is per-machine state, and a shared index would let one paired device suppress scans on another. Persistence here is **load-bearing, not an optimization**: the signal pipeline does not content-dedup, so an in-memory-only repo would re-emit every scanned file on each host restart. 10 unit tests cover round-trip, cross-instance persistence (the no-re-emit property), key-collision safety, atomic write (no lingering `.tmp`), corrupt-snapshot and version-mismatch recovery, and no-op flush.

### Documentation

- **Corrected the idle-miner desktop-integration spec (`docs/idle-miner-desktop-integration.md`) with what building revealed.** The original spec assumed idle-miner runs in the Electron main process; implementing it surfaced that this is wrong: `apps/desktop` is a deliberate thin shell with **zero `@skytwin/*` dependencies**, compiled as CommonJS — it manages the api/worker/cockroach as child processes, so pulling an ESM workspace package into Electron-main breaks that boundary. And the worker is **paused exactly when idle-miner would run** (`IdlePauseController` stops the worker child process on idle, #382), so it can't host the miner either. The corrected host is a **separately-managed idle-miner child process**, spawned by the desktop's `ServiceManager` like api/worker/cockroach, started on the desktop's idle signal and exempt from the worker's idle-pause. The dependency-assembly sections (emitter transform, roots, userId, flag) still apply, relocated into that process.


## [0.6.92.0] - 2026-06-29

### Documentation

- **Added a build-ready spec for wiring `@skytwin/idle-miner` into the desktop (`docs/idle-miner-desktop-integration.md`).** An audit found the idle-miner is genuinely unwired into `apps/desktop` and that wiring it is a multi-piece feature, not a flag-gated call: `startIdleMiner` requires a signal emitter, two persistence repos, and a resolved `userId`, none of which exist for the desktop. The spec front-loads the three non-obvious design findings so the implementation is one focused PR: (1) the emitter must **transform** idle-miner's filesystem `RawSignal` (rootId/absPath/relPath) into the `/api/events/ingest` event shape — it is a *different* type than the connector `RawSignal` the worker forwards; (2) the file-index + cursor repos must be **device-local, not CockroachDB** (a file index is per-machine; the shared DB would let one device suppress scans on another) and persistence is **load-bearing** — ingest has no content dedup, so in-memory repos would re-emit every file on each restart; (3) the Electron **main** process has no paired-`userId` resolution today (userId only arrives via IPC from the renderer), so that plumbing must be added and the miner must fail-closed until it resolves. Includes the flag (`SKYTWIN_IDLE_MINER_ENABLED`, default off), a test plan, and the open design decisions. No code change.


## [0.6.91.0] - 2026-06-29

### Added

- **Capability inference is now scheduled in the worker poll loop (opt-in, `SKYTWIN_CAPABILITY_INFERENCE_ENABLED`, default off).** `runCapabilityInferenceJob` (#201/#202) — which reads a user's recent signals and upserts advisory `app_suggestions` for apps the twin should learn to support — existed but carried a standing TODO to wire it into the worker. It now runs on a daily cadence via the same `nowMs - lastAt >= INTERVAL` + `deadLetterTracker.run` pattern the other scheduled jobs use (metrics-rollup, changelog-poll, domain-extraction). It is **opt-in and default off** so nothing runs autonomously without explicit enablement; the job writes advisory suggestions only — no real-account writes, no sends — and absorbs per-user errors internally. The flag + interval decision is a pure, injectable helper (`capabilityInferenceEnabled()` / `shouldRunCapabilityInference()`) so the gate is unit-tested (13 cases: default-off, exact-"true"-only, fail-closed on `TRUE`/`1`/`yes`/empty, the interval boundary `>=`, and an injected-interval override) without driving the infinite poll loop. The job's and the scheduler's stale "TODO: wire this in" comments are replaced with the shipped wiring + cadence.


## [0.6.90.0] - 2026-06-29

### Changed

- **Corrected a stale, safety-relevant comment on `twinRepository.isDraftsEvalPassed` (#301/#314).** The getter's doc-comment claimed the eval-bench gate was "NOT yet wired into `buildDraftEmailGenerator` — a follow-up". An audit of the draft-email path found that is no longer true: the gate has been wired since #314. `buildDraftEmailGenerator` (`apps/api/src/draft-email-setup.ts`) enforces three fail-closed layers before constructing the *only* `DraftEmailCandidateGenerator` instance — the `SKYTWIN_DRAFTS_ENABLED` env flag (default off), the per-user `drafts_enabled` opt-in, then this eval-bench quality gate — and both the "eval not passed → null" and "read error → fail closed" behaviours are covered by `draft-email-setup.test.ts`. The comment now describes the shipped state and cites the wiring site + tests, so a future reader can't mistake the quality gate for unbuilt. No behaviour change — drafting remains off by default.


## [0.6.89.0] - 2026-06-29

### Security

- **`escalate_to_user` is now a server-enforced non-executing terminal — it can never auto-execute, on any path.** It always means "surface this to the human to decide", and the codebase already depends on that for Safety Invariant #8 (an inbound `SECURITY_ALERT` must NEVER be auto-executed). But `PolicyEvaluator` only force-approved the one `escalate_to_user` whose `reason` was `missing_write_scope` (the scope gate); for every other escalation the guarantee was *incidental* — it held only because inbound signals carry `untrusted_external` provenance, which the injection guard escalates. Cross-model adversarial review found the gap: a HIGH-confidence, reversible, zero-cost `escalate_to_user` on a TRUSTED path (a user's own chat intent, `user_originated`) clears `shouldAutoExecute` at `LOW_AUTONOMY`+, and the events auto-execute branch then routes it to the execution router — where `escalate_to_user` is a registered OpenClaw action with no real handler, so it dead-ends. `PolicyEvaluator.evaluate` now forces `requiresApproval` for **all** `escalate_to_user` regardless of tier/risk/provenance (so `autoExecute = !requiresApproval && …` is always false), landing it in the approval queue, which already renders it as a "tell me what to do" card with the alternative candidates. New tests: `escalate_to_user` forced to approval even at `HIGH_AUTONOMY` with `user_originated` + low risk (where the same-shaped `archive_email` auto-executes); the `missing_write_scope` reason is preserved.

### Fixed

- **Chat calendar intent is now honored instead of discarded — and surfaced as an honest human-completion escalation.** When you tell the assistant "decline that meeting" or "schedule a meeting with Sam", the intent classifier already tags the decision with `rawData.intent` (`decline_event` / `create_event`) — but `DecisionMaker` keyed only off `situationType` and threw the intent away. So "decline that meeting" (routed to `calendar_update`) surfaced an *acknowledge/dismiss* menu — never the decline you asked for — and "schedule a meeting" (routed to `calendar_invite`) offered accept/tentative/decline of a non-existent invite (with an undefined `eventId`) rather than addressing the create. `DecisionMaker` now recognizes the chat intent: `generateCalendarUpdateCandidates` leads with a HIGH-confidence `escalate_to_user` ("You asked to decline a meeting — confirm which event") on a chat `decline_event` (acknowledge/dismiss remain as lower-confidence alternatives), and `generateCalendarInviteCandidates` returns a single `escalate_to_user` ("You asked to schedule a meeting — confirm the time and attendees") on a chat `create_event`. Both gate on `source === 'chat'`, so a real inbound `calendar_update`/`calendar_invite` signal keeps its original menu. **Why an escalation and not an auto-action:** cross-model adversarial review caught that an auto-`decline_invite`/`create_calendar_event` would dead-end at the execution boundary — the chat classifier captures the *intent* but not the *entities* ("that meeting" carries no `eventId`; "schedule a meeting" carries no title/time), the calendar handler hard-fails a decline with no `eventId`, and there is no autonomous `create_calendar_event` handler at all. `escalate_to_user` is the established safe terminal (same one the #485 scope gate and the smart-home generator use; `shouldAutoExecute:false`), so the user is asked to confirm rather than an action silently failing. Entity extraction + a create handler are the follow-up to make these fully autonomous. New tests: chat decline → HIGH escalation carrying the intent + eventId, no auto-`decline_invite`; the escalation needs no calendar scope; a non-chat update keeps acknowledge/dismiss; chat create → a single escalation, no RSVP menu, no auto-create.

## [0.6.88.0] - 2026-06-29

### Fixed

- **`/api/routines` now runs the FULL policy gate before registering an auto-executing cron routine.** The route's `policyEvaluator.evaluate(plan.action, policies, userTier)` omitted both `riskAssessment` and `autonomySettings`, so the spend hard-limit (Invariant #4), the reversibility/risk-dimension escalations, the domain allowlist and quiet-hours were all silently skipped — a costed or irreversible action could be scheduled to run unattended. Now the route risk-assesses the action and loads the user's autonomy settings, passes both to `evaluate()`, and — critically — **refuses creation (403) when the action requires approval**: a routine has no human in the loop per run, so an action the policy engine would escalate must not be registered to auto-run. The policy check runs against a SERVER-DERIVED action — the caller never gets to assert its own cost, reversibility, or provenance. Cost + reversibility are classified from the action TYPE against a small free-action allowlist (note / reminder / label / archive / acknowledge / dismiss → verified-zero + reversible); any other type (outbound, costed, destructive) is unknown-cost + assumed irreversible, so it escalates and is refused. Provenance is forced to `untrusted_external`. And the registered routine carries only the normalized action with EMPTY steps — caller-supplied `steps`/`rollbackSteps` were never policy-checked, so dropping them closes a check-one-thing-execute-another gap (both caught by cross-model review). New tests: requires-approval → 403 (no routine created); `evaluate` receives a riskAssessment + autonomySettings. (Per-run execution still happens on IronClaw's own scheduler with no SkyTwin backstop — a deeper architectural gap noted for follow-up.)

## [0.6.87.0] - 2026-06-29

### Added

- **Schema-drift guard: a static test that fails when a TS enum union and its DB `CHECK` constraint disagree.** The #567 incident shipped because a new `MemoryActionOpportunityStatus` value (`noted_awareness`) passed the whole suite — every `@skytwin/db` repository test mocks the query layer, so none observe a real CHECK constraint — while production CockroachDB would reject the write. The new guard (`packages/db/src/__tests__/schema-enum-drift.test.ts`) parses each TS union's members from source AND the allowed values from `schemas/schema.sql`, and fails with a pointer to the missing migration if they diverge. Covers the named-union enum columns in `schema.sql` (`memory_action_opportunities.status` ⇄ `MemoryActionOpportunityStatus`, `.provenance` ⇄ `ActionProvenance`); a self-test proves the guard actually detects drift. The `CASES` list is one line to extend; covering migration-only tables and inline field-type unions is a noted follow-up.

## [0.6.86.0] - 2026-06-29

### Fixed

- **Approval serializers now round-trip `costZeroIntent` + `provenance`, closing a re-opened spend bypass (#372).** The events ingest route (two `approvalRepository.create` sites) and the chat/assistant route serialized the selected action's `costZeroIntent` as *absent*. On approve, `parseCostZeroIntent(undefined)` returns `undefined`, which the cost gate treats as legacy `verified_zero` (per the documented contract in `decision.ts`) — so an LLM-generated `'unknown'`-cost candidate would clear the spend fast-path after approval instead of escalating. `decision.ts` explicitly warns that any new serializer must carry this flag; these three did not. The three serializers are now consolidated into one `serializeApprovalCandidate` helper (apps/api/src/routes/approval-candidate.ts) — a single source of truth so these safety fields cannot drift between paths again (the root cause). It carries `costZeroIntent` and `provenance` (the worker's memory-action-loop serializer already did), and restores the candidate `id` on the chat/assistant path so the approve handler can relink the stored RiskAssessment (#371). Unit test on the helper + an integration test asserting the events approval payload carries `costZeroIntent: 'unknown'` + `provenance`.

## [0.6.85.0] - 2026-06-29

### Fixed

- **The twin no longer offers to "reply" to newsletters and no-reply senders in the primary decision path.** PRs #564/#568 closed this in the memory-suggestion path, but the core events→decision path still had it: `inferEmailType` (gmail + outlook connectors) classified any subject containing "meeting/invite/calendar" as `meeting_invite` *before* checking the sender, so a webinar blast from `events-noreply@brand.com` became `requiresResponse: true` → a `send_reply` candidate. And `generateEmailTriageCandidates` (decision-engine) generated `send_reply` purely on `requiresResponse`, never consulting the #251 authoring tier. Fixed both layers: (1) the connectors now reject a reply-implying type (`meeting_invite`/`work_email`) for an automated sender — reusing the same `isAutomatedSender` classifier from #568, so compound no-reply aliases are caught; (2) `DecisionMaker` drops outbound reply/draft candidates whenever the authoring tier is an awareness tier (`inbox_newsletter`/`inbox_automated`/`user_sent_*`) — as a **post-generation filter that covers every candidate source** (built-in rules, the LLM strategy, and the draft-email generator on the production path), not just the rule generator. Even if `requiresResponse` slips through, no reply to a newsletter survives. The connectors keep detecting a no-reply token in the raw From (so a `noreply` display name on a human-looking address is still caught). Human inbound mail (`inbox_personal`/`inbox_broadcast`) is unaffected and still gets a reply offer. New tests: connector classification (automated sender + meeting subject → notification; a real person → meeting_invite) and the decision-maker tier gate (reply for human mail, never for awareness tiers, tier read top-level or nested under `data`).

## [0.6.84.0] - 2026-06-28

### Fixed

- **No more "draft a reply" to `google-noreply@google.com` (and other hyphen-compound no-reply senders).** Same bug class as the newsletter-reply fix, one level deeper: a memory-link suggestion offered to draft a reply to an automated Google Terms-of-Service notice. Root cause was a shared anchoring gap in both no-reply detectors — they only recognized the automated token as the **first segment** of the local part (`noreply@`, `noreply+thread@`, `notifications.42@`), so a hyphen-compound like `google-noreply@` slipped through. The connector then mis-tiered it `inbox_personal` (a human!), and the suggestion engine classified it `received_personal` → `draft_email`. Fixed both: `isAutomatedSender` (`@skytwin/connectors`) now also matches a token as the **last segment after a hyphen** (regex built from the token set, so the vocabulary stays single-sourced), and the `NO_REPLY_SENDER` fallback (`@skytwin/shared-types`) now also accepts an alphanumeric-hyphen boundary. Deliberately precise — a token embedded without a delimiter (`noreplyfan@`), a dot-suffixed `firstname.role` (`alex.alert@`, `pat.notifications@`), and a mid-string role word (`real-newsletter-editor@`) all stay personal, matching the original first-segment-only intent. Any rare false positive only errs toward awareness (note, not draft-a-reply) — the safe direction. New tests cover the hyphen-suffix compound, the embedded/dot/mid-string negatives, and the end-to-end `inbox_automated` classification.

## [0.6.83.0] - 2026-06-27

### Fixed

- **The memory action loop no longer re-floods the approval queue with newsletter "note your interest" cards.** The awareness disposition gate (0.6.81.0) only covered the ingest route. The memory action loop is a *second* write path — it turns memory-derived opportunities into one approval each — so at `observer`/`suggest` tier passive "note your interest in this topic" notes from newsletters still piled up as "Needs your OK" cards (verified live: 4 such cards in the queue, all `create_note`, `reversible`, cost 0, escalated only by *Trust Tier Gating*, never by the injection guard). The worker now applies the same gate: when `AWARENESS_DISPOSITION_GATE=on`, a passive, reversible, verified-free memory action that the injection guard did **not** escalate is recorded as **FYI** (`requires_approval=false`, terminal `noted_awareness` status) with **no approval row and no execution** — the same disposition the ingest route applies. The injection guard stays the security boundary: an irreversible draft reply on untrusted newsletter content (which the guard escalates with a `confirmationLevel`) still surfaces as an approval. Provenance is deliberately not consulted — it is `untrusted_external` for the very notes we dispose, and the guard, not provenance, decides whether untrusted content needs confirmation.
- **The awareness gate is now a single source of truth across both write paths.** The passive-action set, awareness authoring tiers, rollout flag, and action-shape predicate (`isPassiveAwarenessShape`) moved to `@skytwin/shared-types`; the ingest-route service (`apps/api`) and the worker both consume them, so the two gates cannot drift. Behaviour of the existing ingest gate is unchanged.

### Fixed (post-/review)

- **Production DB now accepts the new `noted_awareness` status (migration 068).** Cross-model review caught that migration 067's `check_status` CHECK constraint predates this status, so on a real database every disposition would have failed the constraint at `markStatus` — *after* the decision outcome was already persisted as FYI, orphaning the opportunity in a non-terminal, re-claimable state. The unit/integration tests mock the query layer, so none exercised the constraint. Added migration 068 (drop-and-recreate `check_status`, idempotent) and the matching value in `schemas/schema.sql` for fresh installs.
- **The worker gate now disposes only UNTRUSTED awareness content, mirroring the ingest gate's scope.** Adversarial review caught that the first cut disposed any passive/reversible/free note regardless of provenance, so a note derived from the user's own authored or trusted-context memory would silently become FYI instead of an approval. Added a `provenance === 'untrusted_external'` guard (the actual newsletter flood is exactly that), so self-authored and trusted-context notes still surface as approvals — the same spirit as the ingest gate, which only disposes awareness-tier email and calendar updates.
- **Memory-loop outcome statuses render as plain language in the daily briefing, not raw enums.** `noted_awareness` (and its siblings `queued_approval`, `auto_executed`, …) were interpolated raw into user-facing briefing prose. Added a total `Record<MemoryActionOpportunityStatus, string>` label map (e.g. `noted_awareness` → "noted as FYI", `queued_approval` → "waiting for your OK"); typing it as a total record makes a future status without a label a compile error.
- **Test hardening surfaced by a clean-room `tsc` build:** typed the `claimDueForUser` mock return (was inferred `never[]`, so any non-empty `mockResolvedValue` failed `tsc`) and dropped an unused helper parameter — two latent failures that `vitest` (esbuild, no type-check) ran past. Added coverage for the provenance guard, the `label_email` unverified-cost case, the higher-tier auto-execute path, and the `noted_awareness` terminal round-trip / briefing label.

## [0.6.82.0] - 2026-06-27

### Fixed

- **The `AWARENESS_DISPOSITION_GATE` flag now actually reaches the dev server.** 0.6.81.0 added the flag, but `turbo.json`'s `dev` task uses a strict env allowlist, so `AWARENESS_DISPOSITION_GATE=on pnpm dev` was silently stripped before the API process saw it (the gate stayed off, `gateEnabled: false`). Added it to the allowlist. Verified live: a newsletter now ingests as `email_triage` → `label_email` → gated → `requires_approval=false` with no approval row (it lands in the digest as FYI), and the Phase-0 log shows `gateEnabled: true`.

## [0.6.81.0] - 2026-06-26

### Added

- **Awareness disposition gate — stop the approval queue from flooding with things that aren't decisions (flagged, default off).** The newsletter and classify-first fixes improved *which* action a signal gets; this addresses *how many cards* it makes. At `observer`/`suggest` tier the policy engine forces approval on every action and the ingest route creates one "Needs your OK" card per signal — so newsletters, automated notices, the user's own re-ingested sent mail, and "no action required" calendar updates each become a card. `isAwarenessOnly()` identifies a pure-awareness outcome (a passive, reversible, zero-cost action — archive / label / note / acknowledge / dismiss — selected for an awareness-tier email `inbox_newsletter` / `inbox_automated` / `user_sent_*`, or a `CALENDAR_UPDATE`) and, when `AWARENESS_DISPOSITION_GATE=on`, flips the persisted outcome to `requires_approval=false` — so the decision is still recorded but surfaces as **FYI** in the digest (the `needsYou()` read path) rather than a To-do, with no approval row and no `approval:new` SSE. Hard safety carve-outs: it never gates an injection-guard escalation (`outcome.confirmationLevel` set), a non-passive / irreversible / costed action, human inbound mail (`inbox_personal` / `inbox_broadcast`), or a calendar invite. Phased: Phase 0 logs every candidate with no behaviour change, Phase 1 is the flagged suppression. 17 unit tests.

## [0.6.80.0] - 2026-06-26

### Fixed

- **Memory action inference now asks "what is this memory?" before "what keyword does it contain?"** `inferActionPlan` was a flat keyword cascade — any memory whose text happened to match a regex got that action regardless of what the memory actually was: an idle-crawled "Q3 report" inferred a data-analysis action, an ambient "X mentioned you in a LinkedIn post" inferred a draft of a **public** social post, and a past event you attended inferred "schedule a meeting". The newsletter gate (0.6.78.0) only covered email; voice notes, idle-miner files, and chat carry no authoring tier and fell straight through all eight active-action branches. It now classifies the memory first — authored (your sent mail / voice / chat) vs. a real person's inbound mail vs. ambient/received content — from the `source` + `authoringTier` the connectors already record, and only lets the keyword cascade fire for content you authored. Received-but-not-correspondence is filed as a note; a real person's email still drafts a reply. Generalizes the newsletter fix to every signal source. 15 unit tests.
- **Email triage actions now carry the real message id.** `generateEmailTriageCandidates` built archive / label / reply action params from `rawData['emailId']`, but the Gmail and Outlook connectors store the id as `messageId` — so every archive/label/reply action on a real inbound email carried `emailId: undefined` and couldn't identify the message. Mirrors the `?? messageId` fallback the draft-email generator already uses.

## [0.6.79.0] - 2026-06-26

### Fixed

- **Calendar invites are no longer mis-routed into email triage (regression fix for 0.6.78.0).** The newsletter-aware change in 0.6.78.0 taught `classifySituation` to treat any signal carrying an `inbox_*` authoring tier as email — but the calendar connectors stamp an `inbox_*` tier on every invite the user didn't organize (`inbox_personal` / `inbox_broadcast` / `inbox_automated`), and the email block runs before the calendar block. So a real calendar invite matched the email path and got archive/label candidates — and, because meeting invites set `requiresResponse: true`, a possible irreversible "send a reply" *email* candidate — instead of accept / decline / propose-a-new-time. The tier clause is now scoped to non-calendar signals, so calendar invites stay `CALENDAR_INVITE` / `CALENDAR_UPDATE`. The new tests set `authoringTier` on the calendar fixtures (the field production always sets) — the omission that let this through in the first place.

## [0.6.78.0] - 2026-06-26

### Fixed

- **The twin no longer treats newsletters like correspondence.** Connecting a Gmail account used to flood the approval queue with newsletter noise. The daily memory action loop proposed "draft a reply using this memory" for *any* email-derived memory, so a NYT breaking-news blast from `breakingnews@nytimes.com` became a reply draft; and the reactive triage escalated every newsletter as "Decision needed regarding: <subject>" because `classifySituation` only routed `source.includes('email')` to email triage while the Gmail connector emits `source: 'gmail'` — dropping newsletters into `GENERIC`, whose only candidates are a note and a high-confidence escalation. Both paths now consult the `AuthoringTier` (#251) the connectors already stamp: broadcast / no-reply mail (`inbox_newsletter`, `inbox_automated`, or a no-reply sender) infers `create_note` "note your interest in this topic" instead of a reply, and Gmail/Outlook signals plus any `inbox_*` tier classify as `EMAIL_TRIAGE` (archive / label) instead of escalating. `inbox_broadcast` — a cc'd human thread, not a newsletter — still drafts a reply. Hardened by adversarial pre-merge review: the no-reply sender match is anchored so `mary.newsletter@…` (a real person) isn't mistaken for bulk mail, and the tier check reads `authoringTier` from both the top-level event and the nested `data` envelope the connectors actually use. 11 new unit tests across the two paths.

## [0.6.77.0] - 2026-06-25

### Added

- **Memory action opportunities now keep moving instead of stopping at suggestion text.** The worker persists daily memory-derived opportunities into a durable ledger, dedupes them by fingerprint, evaluates each candidate through the normal policy engine and persisted risk assessment path, then either queues approval, auto-executes through the execution router, blocks on policy, records execution failure, or logs the exact OpenClaw/IronClaw skill gap that needs to be learned or connected. The loop runs every six hours, retries due opportunities even when no fresh memory arrived, and keeps explanations plus decision outcomes attached to every attempt.
- **Daily reports now include the memory action loop's actual outcomes.** Briefings still show novel memory suggestions, but now also include a "Memory action loop" section summarizing what SkyTwin tried, what got queued or executed, what policy blocked, and the next step. Approval responses update the same ledger, so a memory action does not stay stuck as "queued" after the user approves or rejects it.

### Fixed (post-/review)

- **Memory action reports now name the adapter that actually executed after fallback.** If the router initially prefers IronClaw but falls back to Direct or OpenClaw, the report records the executed adapter instead of the first route choice.
- **Copilot review fixes hardened the memory action loop approval edge cases.** Malformed persisted `costZeroIntent` values now fail safe to `unknown`, approval execution errors no longer overwrite the route-rationale field, and outbound email memory actions are treated as irreversible before policy evaluation.

## [0.6.76.0] - 2026-06-25

### Added

- **Daily briefings now surface executable action opportunities from memory.** The live digest and briefing generator read recent plus older memory, infer novel or resurfaced actions, and attach a structured action plan that says whether SkyTwin should try IronClaw first, use OpenClaw, or learn/connect a missing capability. Web and mobile briefings render the new "Actions from memory" section, and the briefing prose prompt now includes these suggestions instead of reducing them to generic prose.
- **SkyTwin now tracks known IronClaw/OpenClaw runtime versions explicitly.** `@skytwin/shared-types` records IronClaw `0.29.1`, OpenClaw stable `2026.6.10`, and OpenClaw beta `2026.6.11-beta.1` separately, then exposes that metadata through action plans and `/api/credentials/status`. The Setup page, docs, env example, and briefing report now show stable runtime context without pretending these external runtimes are normal workspace dependencies.

### Changed

- **Claude guidance now routes merge/landing work through the review gate.** `CLAUDE.md` explicitly tells agents to use the PR merge gate for merge preparation: `/review` first, then Copilot review, then `/document-release` before merging.

## [0.6.75.0] - 2026-06-25

### Added

- **No-code routines — the domain foundation (#519, part 1 of a series).** New `Routine` / `RoutineSpec` / `RoutineFilter` types in `@skytwin/shared-types` and a new `@skytwin/routines` package whose `parseRoutineSpec()` turns a plain-language ask ("every morning, summarize my calendar conflicts and anything from finance@acme.com") into a structured, schedulable routine: cadence (hourly / daily / weekly + day-of-week + hour-of-day), a signal filter (sources, sender, keywords, domains), and an action. The parser is **deterministic** (no LLM dependency, fully unit-tested — 25 cases) so the authoring contract is stable; an LLM-backed parse that resolves fuzzy references ("my biggest client") can layer on later with this as the fallback. It guards against footguns: a recurrence cue is required (most chat returns `matched: false`, not a routine), a filter that would match *every* signal raises a warning, and a vague sender it can't resolve to an address is flagged so the user can refine it. **v1 is read-only by design** — routines `digest` or `notify` on matching signals; they never send, reply, schedule, or spend. Action-taking routines (which must route through the policy engine per firing) are a deliberate follow-up. This part ships the types + parser only; the DB/repository, API + chat authoring, worker scheduler, and Routines management page are the next parts in the series.

## [0.6.74.0] - 2026-06-25

### Fixed

- **The "what I can see" coverage panel now actually sees your connected accounts.** The panel read a legacy `connected_accounts` table that **nothing writes to** — OAuth connections are persisted to `oauth_tokens` — so `computeCoverage` always got zero accounts and the panel was stuck in **cold-start ("connect a source") for every user**, even one with Gmail connected. The digest now reads connected providers from `oauth_tokens` (the OAuth source of truth; a row exists iff the connection is live, since disconnect deletes it). Found by an adversarial pre-merge review of the change below — the alternative-provider fix would have been invisible in production without this.
- **The coverage panel now understands that Gmail and Outlook are *alternatives*, not things to collect.** `computeCoverage` treated every source in a capability's allow-list as separately required, so once the Outlook connectors landed (#557) a **Microsoft-only user's panel went all-red** — every capability "unavailable", with prompts to connect Gmail/Google Calendar — even though their Outlook mail + calendar were actively producing commitments. The inverse was also latent: a Google user would have been nudged to "also connect Outlook." Coverage is now computed over **source equivalence groups** (`gmail`/`outlook` → "email", `google_calendar`/`outlook_calendar` → "a calendar"): a group is satisfied by *any* connected member, so a Microsoft-only user gets the exact same capability statuses a Google user gets, and neither is ever told to connect the other vendor. `unlockedBy`/`missing` now carry **human-meaningful group labels** ("connect a calendar") instead of raw, redundant source ids ("connect google_calendar, outlook_calendar"). The `microsoft` provider maps to `outlook` + `outlook_calendar`. 11 unit tests, including Microsoft↔Google status parity and the no-cross-vendor-nudge guarantees.

## [0.6.73.0] - 2026-06-25

### Added

- **Outlook calendar connector (Microsoft Graph) — the calendar half of the Outlook integration.** `OutlookCalendarConnector` is the Microsoft counterpart to `GoogleCalendarConnector` and the companion to the Outlook mail connector (#556). It bootstraps `calendarView/delta` over a 30-day forward window, then **follows the `@odata.deltaLink` incrementally** (changed events only) and emits one `RawSignal` per event, stamped with the same `AuthoringTier` (`classifyCalendarAuthoringTier`) and shaped like the Google calendar signal — `meeting_invite` vs `calendar_event`, organizer, attendees, conflict flag, etc. Graph's `isOrganizer` maps to the classifier's `selfEmail` so events the user organized classify as `user_sent_originated`, and a `responseStatus` of `notResponded` marks `requiresResponse`. It reuses the mail connector's delta machinery: the `@odata.deltaLink` cursor in the `CursorStore`, **410 Gone → re-bootstrap**, and per-poll page caps. Events are **collected across pages, conflict-detected as a set, then emitted in a single pass**, so a mid-sync 410 can't double-fire handlers. Tombstones (`@removed`) and events with no start time are skipped. The new `outlook` (mail) and `outlook_calendar` signal sources are also registered across the downstream source-dispatch sites (signal text extraction, digest source labels, capability-inference signal kind, and the commitment-extractor source gate) so Outlook signals are treated like their Gmail/Google-calendar peers. The worker wires the connector alongside the mail connector for users with `microsoft` tokens. 16 mocked-Graph tests (bootstrap, 30-day window, UTC normalization, organizer-tier, cancelled routing, conflict detection incl. cancelled-exclusion, tombstone skip, multi-page drain, incremental two-poll no-re-emit, incremental cursor follow, onSignal handler fan-out exactly-once, first-request + mid-sync 410). End-to-end against real Outlook needs an Azure/Entra app.

### Fixed (post-/review)

- **Calendar event times are forced to absolute UTC.** Graph returns `calendarView` dateTimes as a **zone-less wall-clock string** (e.g. `2026-06-26T10:00:00.0000000`) plus a separate `timeZone`. The connector now sends `Prefer: outlook.timezone="UTC"` so the values are UTC, and `toUtcIso()` appends `Z` so `new Date(...)` parses them as UTC rather than the **worker's local zone** — without this, conflict math and stored timestamps silently shifted by the worker's offset.
- **Cancelled events no longer masquerade as invites to RSVP to, and don't create phantom conflicts.** A cancelled event whose `responseStatus` is still `notResponded` was emitted as a `meeting_invite` with `requiresResponse: true`; cancelled events now route to `calendar_event` with `requiresResponse: false`. Outlook also keeps the original start/end on a cancelled event (Google strips them), so cancelled events are now excluded from conflict detection — a cancelled meeting no longer flags a real overlapping one.
- **The delta is followed incrementally instead of re-bootstrapped on a timer (no re-emit storm).** An earlier cut re-bootstrapped a fresh window once its runway dropped below ~6 days (~daily) to avoid going blind to far-future events. But re-bootstrapping re-fetches the *entire* window, and `SignalDeduper`'s 24h TTL meant a ~daily re-bootstrap re-presented unchanged events past their dedup window — duplicate decisions/approvals. The connector now bootstraps a generous **30-day** window once and follows the `deltaLink` (changed events only); the rare 410/restart re-bootstrap is absorbed by the deduper's persistent ledger. Trade-off: events scheduled beyond the window (or created after long worker uptime) are picked up on the next reconnect; a true rolling window without re-emit needs Graph `events/delta` (no fixed window, but no recurrence expansion) — tracked as a follow-up. **Known limitation (pre-existing, from #556):** the source-coverage panel doesn't yet map the `microsoft` provider to its sources — that needs an alternative-provider coverage model (gmail *or* outlook covers "email") so Google users aren't nudged to connect Outlook; deferred with explanatory comments in `capability-source-matrix.ts` / `source-coverage.ts`.

## [0.6.72.0] - 2026-06-25

### Added

- **Outlook mail connector (Microsoft Graph) — your inbox now feeds the twin.** `OutlookMailConnector` is the Microsoft counterpart to the Gmail connector, completing the Outlook integration started in #550–#552 (connect → safe token refresh → now *read*). It polls the inbox with Graph's **delta query** and emits one `RawSignal` per message, stamped with the **same `AuthoringTier`** the Gmail path produces, so tier-weighted retrieval treats Outlook and Gmail mail identically. The delta link is the cursor (vs Gmail's historyId) — stored in the same `CursorStore`; a **410 Gone** (expired delta) triggers a re-bootstrap, mirroring Gmail's 404 path, and pages are capped per poll so the initial sync spreads over a few cycles. The Graph fetch wrapper handles 401 (refresh + retry), 429/5xx (retryable with `Retry-After` / `RateLimit-Reset-After`), and 410. `DbTokenStore`'s `googleConfig` is now optional too (symmetric with `microsoftConfig`, same refuse-to-refresh guard) so a Microsoft-only deployment can build the store, and the worker's connector discovery resolves a Microsoft config and wires the Outlook connector for users with `microsoft` tokens. **Scope:** inbound inbox mail (v1); sent-mail capture (the `user_sent_*` tiers) is a follow-up needing a Sent-folder delta. Verified with mocked Graph (7 connector tests: bootstrap, pagination, incremental, 410 re-bootstrap, tier stamping); end-to-end against real Outlook needs an Azure/Entra app.

## [0.6.71.0] - 2026-06-25

### Fixed

- **The OpenClaw bridge can no longer take down the whole `pnpm dev` stack after a one-off `SIGKILL`/exit 137.** Its dev script now runs through a tiny supervisor that restarts `server.mjs` after unexpected exits, including the `137` failure mode seen in long-running local dev, while still failing fast if the bridge crash-loops repeatedly in a short window. The production `start` script remains the direct `node server.mjs` path. A new regression test starts the supervisor, kills the child bridge process with `SIGKILL`, and asserts that a new child is spawned instead of letting Turbo tear down API/web/worker.

## [0.6.70.0] - 2026-06-25

### Fixed

- **`pnpm dev` now fails fast on local port collisions instead of letting Turbo fan out into noisy service crashes.** The root dev script now runs through `bin/skytwin-turbo-dev`, sets the same local defaults as the previous inline command, raises Turbo concurrency above the current persistent task count, and preflights the API, web, OpenClaw bridge, and Twin MCP ports before Turbo starts. If another process owns a required port, the script prints the owning PID, command, and cwd; if this workspace's dev stack is already healthy, a second `pnpm dev` exits cleanly with the endpoint list. The desktop dev service manager now skips embedded Cockroach/API/web/worker startup only when `/api/health` identifies a real SkyTwin API, so a stray `200` on port 3100 can no longer trick it into attaching to the wrong process. Docker Compose no longer pins global container names, and its host ports are configurable via `SKYTWIN_DOCKER_SQL_PORT`, `SKYTWIN_DOCKER_ADMIN_PORT`, and `SKYTWIN_DOCKER_API_PORT`; the Docker-backed setup/dev/e2e helpers now discover the Compose-owned Cockroach container instead of assuming `skytwin-cockroachdb`.

## [0.6.69.0] - 2026-06-25

### Fixed

- **Semantic search no longer silently degrades to vector-only on CockroachDB (`ts_rank_cd` → `ts_rank`).** The gbrain CRDB adapter's `textSearch` ranked the tsvector half of the RRF fold with `ts_rank_cd`, which **CockroachDB does not implement** — verified live on CRDB v23.2.30, it throws `unimplemented: this function is not yet supported`. That made the *entire* tsvector branch of every hybrid semantic search throw, so retrieval fell back to vector-only across the board: the assistant's memory enrichment + source citations AND the new `/api/search` surface. (Found by browser-dogfooding the search page — it soft-failed to "warming up", and the api log named `ts_rank_cd`.) Swapped to `ts_rank`, which CRDB supports and which the verified full `textSearch` query now executes cleanly; the RRF fold uses rank *position*, so the cover-density vs standard ranking difference is immaterial. New regression test asserts the SQL uses `ts_rank` and never `ts_rank_cd`.

## [0.6.68.0] - 2026-06-24

### Fixed

- **`DbTokenStore` token refresh is now provider-aware (closes a latent token-leak footgun).** `DbTokenStore.refreshIfExpired` called Google's `refreshAccessToken` for **any** provider. Harmless while only Google existed — but now that Microsoft tokens can be persisted (#551), refreshing one through `DbTokenStore` would have POSTed the Microsoft refresh token to Google's token endpoint (the same token-leak class fixed in the disconnect routes). It now dispatches by provider: `google` → Google's endpoint, `microsoft` → Microsoft's (via the new optional `microsoftConfig` constructor arg), and **refuses (throws) rather than falling back to Google** for a `microsoft` token when no Microsoft config is wired, or for any unsupported provider. This is the token-refresh foundation the Outlook signal connector needs (a connector calls `refreshIfExpired(userId, 'microsoft')` on every poll). Backward-compatible — the existing Google-only construction and refresh path are unchanged. 5 unit tests assert which endpoint each provider hits + the no-leak refusal; all 25 existing `DbTokenStore` tests still green.

## [0.6.67.0] - 2026-06-24

### Added

- **Connect Outlook — Microsoft OAuth routes.** Building on the `microsoft-oauth` module (#550), `GET /api/oauth/microsoft/authorize` + `GET /api/oauth/microsoft/callback` let an authenticated user connect their Outlook mail + calendar (Graph scopes `User.Read` / `Mail.Read` / `Calendars.Read`). The flow reuses the exact provider-agnostic security infrastructure the Google flow uses — HMAC-signed state (so the public callback can't be spoofed into attaching an account to another user), the consume-on-read PKCE verifier store, and `oauthRepository.saveTokenForAccount` (multi-account keyed on `(user, provider, account_email)`). Config resolves env → DB Setup creds → bundled default (`MICROSOFT_CLIENT_ID` / `SKYTWIN_DEFAULT_MICROSOFT_CLIENT_ID`), defaulting to **user-supplied** (bring your own Entra app) since SkyTwin ships no bundled Microsoft client unless that env var is set. The disconnect endpoint (`DELETE /:provider/disconnect`) now accepts `microsoft` (Entra has no token-revoke endpoint, so disconnect drops the stored rows). Identity comes from Graph `/me`, falling back to `userPrincipalName` when `mail` is null (personal Outlook.com accounts). **Scoped intentionally narrow** vs Google: no new-user-sign-in-with-Microsoft and no desktop pending handoff — just "connect Outlook to my existing SkyTwin account." 8 new unit tests (config precedence, Graph identity + UPN fallback); all 33 existing OAuth tests still green. The Outlook mail/calendar **signal connector** (Graph polling → signals) is the next follow-up; it needs a real Entra app to verify end to end.

## [0.6.66.0] - 2026-06-24

### Added

- **Microsoft Entra OAuth foundation (Outlook connector groundwork).** New `@skytwin/connectors` `microsoft-oauth` module — `generateAuthUrl` / `exchangeCode` / `refreshAccessToken` over the Microsoft identity platform v2 endpoints, mirroring the Google OAuth module (pure, transport-only, returns the shared `OAuthTokenSet`, unit-tested against a mocked `fetch`). It handles the Microsoft-specific details Google doesn't: tenant-scoped endpoints (`common` by default — supports personal Outlook.com *and* work/school Microsoft 365), `offline_access` force-added so the grant always yields a refresh token (Microsoft's equivalent of Google's `access_type=offline`), non-rotating refresh tokens (the stored token is kept unless the response returns a new one), PKCE reuse, and a `MicrosoftOAuthRefreshError` that classifies permanent (4xx) vs transient failures. Exported namespaced (`microsoftOAuth.*`) since the function names intentionally mirror the Google module. 15 unit tests. **This is the foundation only** — wiring the live `/microsoft/*` authorize/callback routes (which carry product decisions: bundled Azure app vs user-supplied client, scope grouping) and the Outlook mail/calendar Graph signal connector are scoped follow-ups; the latter needs a real Azure/Entra app to verify end to end.

## [0.6.65.0] - 2026-06-24

### Added

- **Chat with your twin from your phone.** The assistant has always existed server-side (`POST /api/assistant/messages`), but the mobile app had no surface for it — it was an approvals remote, not a twin in your pocket. New **Chat** tab (`ChatScreen`) talks to the assistant over the JSON path (the client's `Accept: application/json` header makes the route reply in one shot rather than SSE, the right fit for React Native), keeps the thread going across turns, and bumps the request timeout to 60s for LLM replies. The mobile `SkyTwinApiClient` gains `sendAssistantMessage(userId, content, threadId?)`. The Voice screen's long-promised "send to twin" hand-off (`VoiceScreen.tsx` admitted it was missing) now works: a finished transcript pre-fills the Chat composer so you review the transcription before it goes to the twin. Tested: api-client request/body construction (path, payload, threadId-only-when-continuing); mobile typecheck + the full suite (209) green.

## [0.6.64.0] - 2026-06-24

### Added

- **Instant memory search.** The semantic retrieval engine (vector + tsvector RRF via `MemoryPort.searchSemantic`) already powered the assistant's context enrichment, but it was reachable *only* through a chat turn — there was no way to just search your own memory. New `GET /api/search?userId=&q=&limit=` route exposes it directly (mounted under `sessionAuth` + `requireOwnership`, so it's scoped to the authenticated user), and a new **Search** page (`#/search`) in the web dashboard runs an instant, debounced lookup across emails, calendar, and what the twin has learned. Results are awareness-zone styled per `DESIGN.md` (neutral, no iris accent), snippets collapsed to one clean line, origin slugs mapped to plain language with a prototype-key-safe lookup, and the UI drops stale responses so a slow earlier query can't overwrite a newer one. The route soft-fails to an empty `degraded` result set on an embedding outage rather than 500-ing. Tested: route validation/clamping/soft-fail (8 cases) + a web source-text regression suite (escaping, no inline handlers, stale-response guard).

## [0.6.63.0] - 2026-06-24

### Added

- **The assistant cites the memory it consulted.** Every enriched chat reply already pulled twin profile + relevant episodic memories into its system prompt (#147), but the retrieval's source identity was discarded at the context-builder boundary — the chat threw away provenance it had in hand. `ContextBuilder.buildWithSources()` now returns the consulted memories as citable `MemorySource[]` (record id + plain-language origin + a one-line label) alongside the rendered context (`build()` kept as a back-compat shim); `AssistantService` attaches them to both the sync reply and the streaming `done` event metadata, **omitted when empty** so unenriched calls keep their exact prior shape; and the API memory provider now maps `SemanticHit.id`/`source` + the episode id into each hit (previously dropped) and merges richer fields on dedup collisions. The web chat renders a muted **"Based on what I found in your memory"** footer — awareness-zone styling per `DESIGN.md` (provenance is never the iris accent), labels normalized to one clean line, origin slugs mapped to plain language so no internal slug ever reaches the UI. Delivers the Explanation-First promise (*what evidence was used?*) on the conversational surface. New `@skytwin/assistant` unit tests (label normalization, id-less exclusion, source/domain fallback, omit-when-empty, streaming `done` path) plus a web source-text regression suite (jargon-safety, escaping, no inline handlers).

### Fixed

- **Onboarding no longer claims screen / app / window / browser observation it can't do.** The "computer" onboarding step (`apps/web/public/js/pages/onboarding.js`) advertised that a background observer watches "Active application names / Window titles / Browser domain names" and promised Settings controls to manage the list — none of which is implemented (no screen/window/browser capture exists anywhere in the tree, and the enable flow is a documented `#181` stub). Both the choice screen and the follow-on poll screen now describe what `@skytwin/idle-miner` actually does: an idle-time scan of code projects that reads **project metadata only** (manifest dependency keys from `package.json`/`pyproject.toml`/`Cargo.toml`/`go.mod`, the git remote, and the gitconfig name/email — never file contents or natural-language text), and they state explicitly what it does *not* do. A web source-text test pins the copy so the false claims can't regress.

## [0.6.62.0] - 2026-06-24

### Added

- **Outgoing email attribution is now a clear, default-on setting.** SkyTwin-sent emails and reviewed draft replies now get a small plain-text footer linking recipients to the open-source repo (`https://github.com/jayzalowitz/skytwin`), with duplicate detection so the footer is not stacked on retries or edited drafts. Settings exposes a visible "Add SkyTwin footer to sent emails" toggle, the settings API persists it in user autonomy settings, and approval cards preview whether the footer will be added before send. The execution path applies the footer at the send boundary for `draft_email`, `send_reply`, `reply_email`, and `send_email`, converts reviewed `draft_email` actions into real `send_reply` execution after approval, and keeps the policy/routing checks on the final outbound action. The direct Gmail handler now builds proper plain-text MIME for replies and new sends, preserves thread metadata (`In-Reply-To` / `References`), and sanitizes headers before calling Gmail. Tests cover the shared attribution helper, settings API validation, approval/auto-execute plumbing, and Gmail MIME output with enabled/disabled attribution.

## [0.6.61.0] - 2026-06-23

### For contributors

- **Mobile launch smoke checks are green on Expo SDK 56.** The audit found the mobile app still had a stale legacy splash config, an out-of-band React pin, missing SDK 56 foreground notification display flags, and strict-TypeScript gaps in the mobile launch tests. React is back on Expo's `19.2.3` pin, splash config now runs through `expo-splash-screen`, notifications return the SDK 56 banner/list fields, `react-native-zeroconf` has a narrow local declaration, and the mobile typecheck, Expo dependency check, Expo Doctor, and mobile test suite all pass.
- **Pre-launch dependency checks now cover the full workspace.** The extended audit found dev/build-chain advisories in Vitest/Vite/esbuild and a transitive desktop-packaging `tar` path. Vitest is now on the patched 3.2.6 line across the workspace, `esbuild` and `tar` are pinned to patched versions through pnpm overrides, and both production and full `pnpm audit` runs are clean.
- **Turbo's GitHub Actions cache is now non-blocking.** The cache proxy is still used when available, but GitHub cache API reservation failures now degrade to a cache miss instead of failing the Test job after install/build/test have already passed. The desktop idle bridge test is also deterministic under Vitest 3 on CI: explicit `powerMonitor: null` now means "headless/no monitor" instead of falling back to Electron resolution, and fake timers are cleared between cases. Windows package validation now builds the prompt and registry packages with portable Node copy scripts instead of Unix-only `cp -r` commands.

## [0.6.60.0] - 2026-06-23

### Fixed (post-merge pre-launch audit rerun)

- **The dashboard memory settings route now uses the shared localStorage keys.** The post-merge browser sweep found `#/memory-settings` still reading obsolete dotted keys (`skytwin.userId` / `skytwin.sessionToken`), so the page issued three API calls with an empty `userId` and produced 400s plus console errors. It now imports `KEY_USER_ID` / `KEY_SESSION_TOKEN`, URL-encodes the user id, and has a regression test to keep it aligned with the rest of the SPA.
- **Mobile dashboard pages no longer gain horizontal scroll from the global pause control or long setup snippets.** The same rerun found the global pause mount sitting in the document flex flow at 390px widths, and long inline MCP setup paths could force page-width overflow. The mount is now fixed-positioned as intended, inline `code` wraps at mobile widths, `pre` blocks keep overflow inside the snippet, and CSS source tests pin those layout guardrails.

## [0.6.59.0] - 2026-06-23

### Fixed (pre-launch code audit)

- **Full pre-launch audit pass fixed launch-blocking runtime and QA failures.** The web dashboard's twin-server token page no longer renders an inline `onsubmit` handler; token generation now uses the repo-standard delegated submit listener pattern, keeps the handler hash-gated to `#/twin-server-tokens`, and uses short native select labels so the token form fits on mobile widths. The API user routes now resolve `:userId` as UUID-or-email before repository lookup, so email-based routes no longer fall into UUID parsing, and ownership checks compare email parameters against the authenticated user's actual row. Policy rows returned from Cockroach now normalize `INT8` priority values back to numbers before the policy engine reads them. The e2e runner can reuse the existing Cockroach container name and enables the dev-auth bypass only for the local e2e process, which restores the real DB/API smoke path. Added regression tests for the token page event pattern/mobile labels, email lookup routing, policy priority normalization, and the conservative `observer` new-user trust tier expectation.

### Security

- **Production dependency audit is clean again.** Root `pnpm` overrides pin patched transitive versions for `fast-uri`, `hono`, `qs`, and `uuid`, resolving the production advisories that surfaced during the launch audit without broad dependency churn.

## [0.6.58.0] - 2026-05-23

### Documentation

- **README leads with downloads.** `## Quick Start` now opens with a "Download and install (no terminal)" section pointing at [the latest release](https://github.com/jayzalowitz/skytwin/releases/latest), a per-OS installer table (`.dmg` / `.exe` / `.AppImage` / `.deb` / `.rpm`), and the unsigned-build first-launch bypass (right-click → Open on macOS, More info → Run anyway on Windows). The `curl … | bash` one-command install moved down to "Build from source." Added a download badge linking to `/releases/latest`; removed the stale hardcoded "2985 tests passing" badge. v0.6.58.0 is the first build published with installer artifacts attached — the release pipeline that produces them was fixed across PRs #352–#356.

### Fixed (CI release pipeline + post-#350 Copilot review)

- **`release.yml` pnpm-setup conflict.** All three release-matrix jobs (mac/win/linux) were failing at `pnpm/action-setup@v4 with version: 9` because v4 also reads the `packageManager` field from `package.json`, and seeing both inputs raises `ERR_PNPM_BAD_PM_VERSION`. Upgraded to `@v5` (matches `build.yml`'s usage — reads only the `packageManager` field). The v0.6.57.0 tag couldn't ship artifacts because of this; v0.6.58.0 + a tag re-push is the path to a working GitHub Release.
- **`build.yml` auto-publish on tagged main.** Once the v0.6.57.0 tag landed on main, electron-builder's auto-publish heuristic on the desktop-macOS validation job tried to upload to GitHub Releases without the `GH_TOKEN` the validation pipeline never sets (build.yml is the validation gate; release.yml is the publish path). All three platform `package:*` invocations in `build.yml` now pass `--publish never` explicitly, decoupling validation from publish regardless of branch/tag context.
- **`release.yml` parity with `build.yml`'s PR #350 fixes.** Added the CRDB binary cache path (`~/.cache/skytwin/crdb-binaries`) to all three matrix entries and the Defender ExclusionPath step on the windows-latest entry, so the release path doesn't re-discover the same Windows `makensis` mmap-race + slow-copy bottlenecks PR #350 already solved.
- **`install.sh` worktree detection.** The "already cloned" branch used `[ -d "$INSTALL_DIR/.git" ]`, which is false in Conductor worktrees and any other gitlink setup where `.git` is a 75-byte file pointing at the shared object store. The header comment promised it handled gitlinks; the code didn't. Swapped to `[ -e ... ]` — `git -C` follows the gitlink transparently so fetch+merge works either way. Users running the installer inside a worktree no longer fall through to the "no .git directory — use as-is" branch and silently skip the pull.
- **`oauth-pending-signin-repository.remember()` now actually calls `sweepExpired()`.** The header docstring claimed best-effort cleanup on every remember, but the function only did the upsert. Without the sweep, abandoned OAuth flows (consent tab closed, wizard killed, 5-min poll timeout) grew the table monotonically. Sweep is now invoked best-effort (caught + swallowed) after the primary write succeeds — housekeeping that can't break the main path.
- **`generatePendingKey()` guards `crypto.getRandomValues` too.** The Web Crypto polyfill path checked `crypto.randomUUID` then unconditionally called `crypto.getRandomValues` — in the exact environment the fallback was supposed to cover (no `crypto` global), the unchecked call would throw a generic `ReferenceError` instead of a useful "browser too old" message. Added an explicit `typeof crypto` + `typeof crypto.getRandomValues` guard; on miss, throws a typed `Error` naming the missing primitive and pointing at the existing-user sign-in path as a fallback.
- **`packages/db/connection.ts` no longer silently downgrades on a typo'd `sslmode`.** The function returned `undefined` for any unknown value, which then fell through to the `DATABASE_SSL` env var (default `false`) — so `DATABASE_URL=…?sslmode=requier` would connect over plaintext against what should have been a secure cluster. Unknown values now throw a typed error at startup naming the misspelling and listing the valid libpq values (`disable`, `allow`, `prefer`, `require`, `verify-ca`, `verify-full`). `allow` and `prefer` get explicit returns matching libpq semantics so they're no longer "unknown."

## [Unreleased] — Tier 2 launch polish

### Changed (dependency bumps — second batched dependabot rebase)

- **Batched the dependabot bumps opened after #522 into one lockfile regeneration:** `expo-camera` ~56.0.8, `expo-asset` ~56.0.17, `expo-notifications` ~56.0.18, `expo-audio` ~56.0.12, `expo-file-system` ~56.0.8, `@react-navigation/native` ^7.3.3 (mobile); `jsdom` 25→29 (web dev — a 4-major jump, the one to watch); `turbo` 2.9.18, `prettier` 3.8.4 (root dev). The six `expo-*` versions match Expo SDK 56's `bundledNativeModules` pins exactly (what `expo install` would pick). **`react-native` 0.86.0 (#535) was deliberately NOT taken** — Expo SDK 56 pins RN to 0.85.3, so bumping it standalone breaks the Expo/RN alignment; RN is upgraded via the Expo SDK, not dependabot. Also raised root `engines.node` `>=20.0.0` → `>=20.19.0` to match the strictest constraint the dependency tree already carried (advisory — no `engine-strict`). Verified: `pnpm build` 35/35, `pnpm lint` 61/61, web tests 64/64 (jsdom-29 a11y/jsdom-env tests pass), mobile 224 unit tests pass — the only local misses are the `integration-live` suites that need a running API+DB (green in CI). The pre-existing `@expo/dom-webview` peer warning in the expo tree is unchanged. Supersedes dependabot PRs #527–#534 and #536; #535 (react-native) is closed unmerged for the Expo-pin reason above.

### Security (redact email addresses from LLM prompts — #375, decision pipeline)

- **The decision pipeline no longer ships contacts' email addresses to a cloud LLM.** `PromptBuilder.buildCandidatePrompt` / `buildSituationPrompt` dumped the raw signal (`decision.rawData` / the raw event) and episodic-memory summaries straight into the prompt — for inbound email that's the sender + recipient addresses, and for memory it's whatever a prior signal quoted. When the provider chain resolves to Anthropic / OpenAI / Google, all of that left the machine. New pure `redactPromptPii()` (`packages/llm-client/src/redact.ts`) masks email addresses to `[redacted:email]`, and both prompt builders apply it by default (opt out per-call with `{ redactPii: false }` for a fully-local provider). Masking is safe for the decision path: an action's recipient is resolved from the structured signal record, never parsed from the prompt, so the model only loses an identifier it didn't need to reason about the content (dates, deadlines, prose are untouched — the redactor is email-only on purpose, since a digit-run matcher would eat ISO dates). Scope note: number/name redaction and the interactive assistant's memory-context block are deliberate follow-ups (numbers need date-aware exclusions; the assistant answers the user's questions about *their own* data, where blanket masking would break legitimate "what's X's email" answers — that path needs provider-trust gating, not a blunt redactor). Tests: the `redactPromptPii` unit (emails single/multiple/embedded-JSON/subdomain/plus-addressing, prose+dates+numbers untouched, idempotence, bare `a@b` ignored) + prompt-builder redaction-by-default and `redactPii: false` passthrough for both builders.

### Added (desktop auto-update — user-facing layer, #370 follow-up)

- **The desktop app now tells you when an update is downloading and lets you install it.** `apps/desktop/src/auto-update.ts` already polled GitHub Releases and silently auto-downloaded on the next quit; this adds the half a user can see and act on:
  - **Live status stream.** `ElectronUpdaterBackend` now subscribes to electron-updater's lifecycle events (`update-available` → `download-progress` → `update-downloaded` / `error`) and normalizes each through a pure `updateStatusFromEvent()` mapper. `AutoUpdateController.start()` wires that subscription, schedules the 6-hour poll, and fires an immediate check; `onStatus()` fans every status change out to listeners (a throwing listener can't break the update loop), and `installNow()` applies a downloaded update only when one is `ready-to-install` (returns `false` — without touching the backend — on a dev/unsigned build or before a payload is downloaded).
  - **Renderer banner (`apps/web/public/js/components/desktop-update-banner.js`).** A single bottom-center banner — deliberately NOT a top banner, so it never fights the autonomy/connector banners' page-reflow — updates in place across the lifecycle: a quiet "Downloading an update…" with a percent progress bar, then "Update ready to install" with a **Restart to update** accent CTA (DESIGN.md: accent = "needs you / act"). Plain-language copy, no internal jargon. A routine background-poll failure is suppressed (no 6-hour nag); an error only surfaces when a download was actually in flight.
  - **Manual check.** A "Check for Updates…" menu item (macOS app menu per HIG; Help menu on Windows/Linux) triggers an on-demand poll via the new `update-check` / `get-update-status` / `update-install` IPC handlers and the `skytwinDesktop.{checkForUpdates,getUpdateStatus,installUpdate,onUpdateStatus}` preload bridge.
  - Tests: controller event-forwarding / unsubscribe / throwing-listener isolation / `start()` idempotence / `installNow()` gating (ready-to-install only), the pure `updateStatusFromEvent` mapping, the menu placement (app menu vs Help), and the banner view-model + HTML builder (visibility, percent clamping, error-suppression, XSS-escaping, `data-action` not inline onclick).

### Changed (dependency bumps — batched rebase of the open dependabot PRs)

- **Batched the 10 open dependabot bumps onto current `main` in one lockfile regeneration** (they had all gone stale/conflicting after the 27-PR launch-readiness merge wave; rebasing each individually would have re-conflicted on `pnpm-lock.yaml` serially). Versions are the manifest ranges actually written by `pnpm up` (it resolves each `^`/`~` range to the newest in-range release at install time, so a few landed a patch/minor above dependabot's original target): `electron-updater` ^6.6.0→^6.8.9, `electron` ^42.2.0→^42.4.0, `electron-builder` ^26.8.1→^26.15.3 (desktop); `expo` ~56.0.8→~56.0.12, `@react-navigation/native-stack` ^7.16.0→^7.17.5, `react` 19.2.6→19.2.7, `@types/react` ~19.2.15→~19.2.17 (mobile); `bonjour-service` ^1.3.0→^1.4.1 (api); `@types/node` ^25.9.1→^25.9.3, `tsx` ^4.22.3→^4.22.4 (workspace-wide dev-deps); `eslint` ^10.4.0→^10.5.0 (in-range; lints clean). Full `pnpm build` (35/35) + `pnpm lint` (61/61) green; the only local test misses are the `integration-live` suites that need a running API+DB (they pass in CI). Supersedes dependabot PRs #469–#494.

### Added (locale/timezone faithfulness — connector profile sync, #486)

- **Google profile sync now populates `users.language` + `users.timezone`, and commitment extraction routes by locale.** The locale/timezone *foundation* (migration `063`, the `decision-engine/src/locale.ts` helpers `resolveLanguage`/`resolveTimezone`/`isNonEnglish`, the briefing `{{language}}` wiring, and `userRepository.getLocale`) landed with the Inbox-Intelligence epic but nothing actually wrote those columns. This PR closes that gap:
  - **New `fetchGoogleProfileSync()` (`packages/connectors/src/google-profile-sync.ts`)** reads the user's Google `locale` (OpenID userinfo → `language`) and their primary calendar's `timeZone` (→ `timezone`) on the same access token the OAuth callback already holds. The two reads are independent (a missing calendar scope still yields the language); the function never throws and never silently guesses — it resolves to safe defaults (`language` → `'en'`, `timezone` → `'UTC'`) with `languageDefaulted` / `timezoneDefaulted` flags so the caller logs a warning instead of inventing a clock.
  - **`apps/api/src/routes/oauth.ts` calls it best-effort after token persistence**, writing only the non-defaulted fields via the new **`userRepository.updateLocale()`** so a partial sync can't clobber a real value with a placeholder, and logging a warning when the timezone (or language) falls back to its default. A failed sync never blocks sign-in.
  - **`extractCommitmentsLocaleAware()` (`packages/decision-engine/src/commitment-extractor.ts`)** is the routing entry point: an LLM strategy is the multilingual path (owns the locale, never degraded); the deterministic English regex fallback running on non-English content now returns a `degraded: 'locale'` marker **and logs the coverage gap** instead of silently returning `[]` as if there were no commitments. English (and unknown) locales keep the un-degraded fallback — no regression for the existing population. Authorship gating (safety #8) is unchanged: a non-English marker is never an excuse to read commitments from content the user didn't author.
  - Tests: profile-sync (non-English locale + non-UTC tz capture, bearer-header plumbing, both-defaults fallback, independent-read partial failure, never-throws, non-string-shape rejection), `updateLocale` (both fields / partial / no-op / not-found), and locale-aware commitment routing (English un-degraded, unset→English, non-English fallback marks+logs degraded, LLM strategy never degraded, authorship gating across locales).

### Documentation (launch-readiness audit — 2026-06-14)

- **Full launch-readiness audit + new [`docs/launch-readiness-report.md`](docs/launch-readiness-report.md).** Audited every open issue against the actual code (not the issue narrative), built/tested/linted the whole monorepo, and QA'd the running dashboard against the epic #357 launch criteria. Finding: SkyTwin is **launch-ready on the engineering side** — every code-writable launch criterion has shipped (sample-profile cold-start, explanations, approve/reject microcopy, the **Pause everything** panic button #379, and **Delete my data** #376 are all live and QA'd with zero console errors), and the full suite (**3,821 passing tests** across 307 files) is green. The remaining launch blockers are external (Apple/Windows code-signing certs #368/#359, Google OAuth verification #351, mobile store assets + accounts #369/#360) plus one code task that needs a human key-management decision first (#374 memory-at-rest encryption, paired with #401). The report carries the per-issue verdict table and an ordered next-actions list.
- **Closed four issues verified shipped in code:** #476 (deadline/temporal extraction), #477 (signal topic clustering), #479 (inbound security-alert classifier, escalate-only), #489 (digest Power view). Each close comment cites the implementing files + tests.
- **CHANGELOG now records the Inbox-Intelligence epic** (below — it had merged via #488 with no changelog entry). **README** test/package counts corrected to ground truth (3,800+ tests across 307 files in 29 packages + 7 apps; previously listed inconsistently as "1,436" / "~2,985" / "36 workspace packages"), the Inbox-Intelligence briefing added to "What works today", the Project Status paragraph updated to the audit result, and the Launch Plan + Launch-Readiness Report linked from the docs table. **CONTRIBUTING** getting-started now seeds the demo profile so tour mode works on first run.

### Added (per-app spend attribution — closes #323)

- **MCP-action spend is now tagged with its registry source, closing the last open AC on #323.** Migration 054, the `spendRepository.create` / `checkAndRecordSpend` `registryId` parameter, and the per-app `getMonthlyTotal(userId, appRegistryId)` query all shipped in v0.6.48.0 (PR #329), but the decision pipeline had no recording site that *knew* its registry source — so `registry_id` was always NULL and per-app monthly caps stayed dark. That dependency landed via #324-partial (PR #330: the action's target MCP server is on `action.parameters.mcpServerId`). New helper `apps/api/src/mcp-action-spend.ts` (`recordMcpActionSpend`) runs after a candidate executes through the trust-ranked router on both the auto-execute path (`routes/events.ts`) and the approved-execute path (`routes/approvals.ts`): it resolves `mcpServerId` → `mcp_servers.registry_id` via `mcpServerRepository.getById` and writes the spend tagged with that `registryId`. Actions with no MCP target (Direct / IronClaw / auto-selected), a missing server row, or a server with no `registry_id` record with `registryId` left undefined → the column stays NULL and the row rolls into the user-global monthly total only, never a per-app total (exactly the semantics migration 054 documents). Only successful, non-zero-cost executions are recorded; the write is a post-execution *ledger* entry (the spend cap was already enforced upstream by the policy engine, Safety Invariant #4) and is best-effort — a ledger failure is logged and swallowed so it can never break an already-executed action's response. Eight unit tests cover the resolve-and-tag happy path plus the NULL-registry fallbacks (no `mcpServerId`, non-string `mcpServerId`, server gone, server without `registry_id`), the zero/negative-cost skip, and the swallow-on-repository-error invariant.

### Added (Inbox-Intelligence epic — #484, merged via #488)

- **Digest read layer + source-agnostic extractors + briefing UI.** The dashboard briefing is now a source-cited daily/weekly digest that splits **to-dos (act)** from **topics (FYI)**, with a **Power view** toggle for the technical depth behind each call. Shipped specs, all wired into the live digest path (`apps/api/src/services/live-digest.ts` → `buildDigest`): act/FYI split (#474), SignalText normalization (#480), deadline→urgency extraction (#476, `deadline-extractor.ts`), topic clustering (#477, `topic-clusterer.ts`), inbound security-alert classifier — escalate-only, zero auto-execution (#479), two-bucket source-aware cited UI (#481), launch demo fixture (#482), grandma-seed new-user bootstrap (#483), locale/timezone foundation (#486), source-coverage / graceful-degradation model (#487), and the Power view inline technical depth (#489, `digest-detail.ts`). Migrations `063`/`064`; ~25 new test files. Three child extractors were built + tested but not yet consumed in the live path and remained open under #484: hide/pin enforcement (#485), commitment extraction (#475 — now wired, see below), and entity cross-linking (#478).

### Added (commitment to-dos wired into the live digest — #475)

- **The user's OWN stated commitments now surface as to-dos in the daily digest.** `extractCommitments` (the rule extractor built + tested in `packages/decision-engine/src/commitment-extractor.ts` under #484) was previously unconsumed in the live path. `apps/api/src/services/live-digest.ts` now runs it over every decision whose underlying signal the user authored (sent mail, calendar descriptions, voice notes — `SignalText.authoredByUser`), turning phrasings like *"I'll send over the draft tomorrow"* into a first-class to-do. Each commitment to-do carries `ActionProvenance = user_originated` (highest trust), an `ExplanationRecord` that cites the user's verbatim sentence (`rawSpan`), the raw `deadlineHint` when present, and a synthetic unique ref (`<decisionId>#commit-N`) so it never collides with the decision's own digest item. The security boundary holds: `extractCommitments` itself gates on `authoredByUser` AND the capability×source matrix, so inbound "you agreed to X" content (a poisoning vector — safety invariant #8) is never read for commitments; restated commitments collapse to one to-do. Extraction is on by default and pure-when-off behind the issue's rollback flag `COMMITMENT_EXTRACTION=off`; any extractor throw is caught so it can never break the digest. Four new `live-digest` integration tests cover the happy path (two commitments → two to-dos with from-you provenance + citation + deadline hint), the gating fallback (identical phrasing on inbound content → no to-do), same-body restatement dedup, and the rollback flag.

### Fixed (post-/review, #378 follow-up)

- **Removed dead `acquireTimeoutMillis` config from `packages/db/src/connection.ts`.** #378 added `acquireTimeoutMillis: 5000` to `DatabaseConfig` + `DEFAULT_CONFIG`, but it was never passed into `new Pool({...})` and — verified against pg-pool 3.14.0's source — pg-pool reads only `connectionTimeoutMillis`, never `acquireTimeoutMillis` (the `@types/pg` `PoolConfig` doesn't even declare it). The field's JSDoc claimed "Supported in pg-pool ≥ v3.6," which is false. The behavior #378 promised (saturated acquires fail within ~5s instead of hanging) was already present and correct via `connectionTimeoutMillis: 5000` — pg-pool uses that single bound for both new-connection establishment and the wait for a free slot when the pool is full (`index.js`: when `_isFull()`, the pending-queue waiter is armed with `connectionTimeoutMillis`). Dropped the dead field and corrected the inline + CHANGELOG comments to attribute the bound accurately. No behavioral change — the acquire timeout was, and remains, 5s.

### Fixed (Epic D — privacy-policy accuracy, #375)

- **Privacy-policy summary no longer makes an unconditional "never leaves your machine" promise it can't keep (#375 fix c).** `docs/privacy.html`'s top-line Summary callout said *"Your Google data … never leaves your machine"* with no caveat — directly contradicting the detailed "Data sharing & transfers" section below it (which already documents that an opt-in cloud AI provider sends decision content off-device) and contradicting the behavior #375 flags: a stranger reads the summary, enables Anthropic in Settings for sharper reasoning, and is surprised their email senders/snippets now leave the machine. The summary now states the local-first default explicitly (built-in on-device model → nothing leaves) **and** names the one opt-in exception (enabling a cloud AI provider sends each decision's content to that provider), linking to the new `#ai-providers` anchor on the detail section. This closes the launch-scoped documentation half of #375 (fix a — the local-first provider-chain default — shipped in #447; fix b — the in-prompt PII redactor — is the issue's explicitly-deferred v0.8 item). Also materially de-risks the #351 Google OAuth restricted-scope review, whose reviewers read this exact summary and check that the stated data flows match behavior. Documentation-only — no code change.

### Fixed (Epic C — mobile pairing on locked-down WiFi, #384)

- **mDNS pairing failure now diagnoses the cause and offers a working manual-IP fallback (#384 P2.4).** Pre-fix, mDNS discovery (`apps/mobile/src/services/discovery.ts`) is LAN-multicast — most enterprise / office / AP-isolated WiFi blocks it — so pairing timed out with a generic "not reachable" error and a manual-entry screen that found the host but then dead-ended on *"scan the QR code to complete pairing"* (it had no token, so it couldn't actually pair). New pure `apps/mobile/src/services/discovery-diagnostics.ts`: `classifyTimeout({ servicesFound, connectAttempted, connectFailed })` → `no-mdns` (multicast blocked — the office case) / `mdns-but-no-connect` (host seen but unreachable — firewall) / `unknown`, each with targeted `troubleshootingMessage` copy; and `normalizeManualAddress` which validates + normalizes a typed address into a base URL (bare IPv4, `host:port`, bracketed + bare IPv6, hostname, full http(s) URL — rejecting whitespace, empty hosts, out-of-range ports, and `http://` with no host). New `apps/mobile/src/services/paired-host-store.ts` remembers the last successfully-typed address in the OS secure store and pre-fills it next time. `PairingScreen.tsx` now: keeps the scanned token/userId in a ref so the manual path **completes** pairing (uses the scanned token for the auth-gated health probe, `saveSession`s on success, and remembers the address) instead of bouncing the user back to the QR scanner; classifies the failure and, for the multicast-blocked / firewall causes, promotes "Enter address manually" to the primary action with cause-specific troubleshooting copy; and pre-fills the manual field from the remembered host. 28 new vitest cases — classifier (every signal combination + non-empty copy), address normalizer (12 accept/reject cases incl. IPv6 + custom port), and the secure-store host persistence (round-trip, trim, empty-ignore, overwrite, clear). 235 mobile tests pass; changed files clean under `tsc` (mobile stays at the 6 pre-existing base errors). Manual smoke on a real multicast-blocked network is deferred to a device pass — the classifier + normalizer + persistence are the unit-testable core, which is fully covered.

### Added (Epic C — mobile resilient voice upload, #386)

- **Resumable chunked voice upload — a cellular drop re-sends one chunk, not the whole memo (#386 P2.6).** Pre-fix, a 2-minute voice memo (~3MB base64) went up as a single `POST /api/voice/transcribe`; a mid-upload disconnect on spotty cellular meant starting over with no progress and no retry. This PR adds a resumable chunked path end-to-end at the service layer. **API:** new `apps/api/src/lib/upload-session.ts` `UploadSessionStore` — in-memory, TTL-swept (10min idle), ownership-checked session store that accepts base64 string chunks in any order, replaces retried chunks in place (no double-counting toward the size cap), reports the missing-index list, and concatenates chunks in index order on finalize (the full base64 is decoded exactly once, so there's no per-chunk alignment concern). Four new endpoints on the voice router — `POST /api/voice/upload/{session,chunk,finalize,cancel}` — share the same whisper transcription tail as `/transcribe` (refactored into a `runTranscription` helper) and inherit the router's `sessionAuth + requireOwnership` (body `userId`) plus the store's own per-session owner check. The 25MB ceiling from the single-shot path is mirrored on the chunked total so the new route can't smuggle a larger payload. **Mobile:** new pure `apps/mobile/src/services/voice-chunker.ts` (`chunkBase64` / `countChunks` / `reassembleChunks`), four `voiceUpload*` methods on `SkyTwinApiClient`, and a `transcribeRecordingChunked` orchestrator in `voice-service.ts` that opens a session, uploads each chunk with **per-chunk** exponential-backoff retry (1s→8s cap, default 4 attempts), reports progress + a `retrying` flag via an `onProgress` callback, supports cooperative cancellation (`isCancelled()` checked before each chunk → best-effort server cancel), and finalizes to transcribe. **Tests:** 13 store unit tests (in-order / out-of-order reassembly, retried-chunk replacement, gap list, ownership, size cap, TTL sweep + refresh, cancel), 4 route integration tests (full session → finalize, resume-after-gap with a 409 missing-list, cancel → later chunk 404s, bad totalChunks), 12 chunker unit tests, and 6 orchestrator tests (happy path, single-chunk retry, give-up-and-cancel after max retries, mid-upload cancel, no-audio short-circuit, 503 → whisper_unavailable). 779 API + 212 mobile tests pass; API tsc clean, mobile tsc unchanged at the 6 pre-existing base errors. **Scoped to the resilient-upload backbone** — the `VoiceScreen` visual progress bar + "Connection lost — retrying" affordance + cancel button wire onto the `onProgress`/`isCancelled` hooks this PR exposes and are a follow-up on #386 (they need the live API + a device to verify meaningfully). The single-shot `/transcribe` path is unchanged for small clips + backward compatibility.

### Added (Epic C — mobile deep links, #387)

- **Approval notifications deep-link to the specific approval (#387 P2.7, routing slice).** Pre-fix, tapping an approval push opened the app on the Approvals tab *root* — the user then scrolled to find the item the notification was about. New `apps/mobile/src/services/deep-link.ts` is a pure, Expo/RN-free module: `parseSkytwinUrl('skytwin://approvals/<id>')` → `{ route: 'approval-detail', id }` (case-insensitive scheme, query/fragment stripped, id URL-decoded, malformed-encoding / wrong-scheme / unknown-host / empty-id all → null), `approvalDeepLink(id)` builds the matching encoded URL, and `deepLinkFromNotificationData(data)` extracts a target from a notification payload (prefers the `url` deep link, falls back to a bare `approvalId`). The `skytwin` scheme is registered in `app.json`. `notifications.ts` `scheduleApprovalNotification` gains an optional `approvalId` that stamps both `data.approvalId` and `data.url` onto the push. `App.tsx` wires the warm path (`addNotificationResponseReceivedListener`) and the cold-start path (`getLastNotificationResponseAsync`) through `deepLinkFromNotificationData`, sets a `focusApprovalId`, and forces the Approvals tab forward; `ApprovalsScreen` consumes the id once the list has loaded — expanding the card and `scrollToIndex`-ing it into view (with an `onScrollToIndexFailed` → `scrollToOffset(0)` fallback for not-yet-measured rows), then clearing the focus. 17 new vitest cases cover the parser + the payload extractor exhaustively (round-trip, encoding, precedence of `url` over `approvalId`, every null path). **Scoped to the deep-link routing half of #387** — the native inline "Approve / Reject" notification actions (iOS Notification Service Extension + Android `NotificationCompat` actions + background submit) require separate native targets + entitlements and a device to verify, so they're tracked as a follow-up on the same issue. Manual cross-platform tap-the-push smoke is deferred to a device pass; the routing logic is fully unit-tested in the pure module. The 6 remaining `tsc --noEmit` errors are pre-existing on base `main` (unrelated files); the changed files are clean.

### Fixed (Epic C — mobile resilience, #388)

- **Mobile SSE drop now shows a "Reconnecting…" banner with backoff + pull-to-refresh override (#388 P2.8).** Pre-fix, `apps/mobile/src/services/sse-client.ts` already auto-reconnected with exponential backoff, but the only UI signal was a quiet red Connected/Disconnected dot the user could easily miss — a network drop left stale data on screen with no actionable feedback and no way to force a retry. New `apps/mobile/src/services/sse-reconnect.ts` is a pure state machine + backoff: `nextReconnectDelay(attempt)` returns the deterministic 1s→2s→4s→8s→16s→30s(cap) curve, and `reduceConnectionState(current, event)` models `connecting → connected → reconnecting → disconnected`. The `connecting` vs `reconnecting` distinction is what lets the Approvals screen show the banner only after a real *drop* — a slow first connect doesn't flash "Reconnecting…" before we've ever connected. The client now drives that state machine (replacing its inline `reconnectDelay` counter with an attempt index fed through `nextReconnectDelay`), exposes the full `getState()` plus a new `reconnectNow()` that resets the backoff and retries immediately (cancelling the pending timer + aborting the dead connection so we never end up with two readers), and fires an `onStateChange` callback alongside the legacy `onConnectionChange` boolean. `ApprovalsScreen.tsx` renders a yellow "Reconnecting… / Pull down to retry now" banner above the list whenever the state is `reconnecting`, and its pull-to-refresh handler now calls `reconnectNow()` so a user staring at the banner can skip the remaining backoff wait instead of watching it count down. Ten new vitest cases lock the backoff sequence (including custom-options and garbage-input clamping) and every state-machine transition (open/drop/stop from each state, the no-premature-banner rule, and a full disconnect→reconnect→stop cycle). The streaming fetch/reader loop is unchanged; all the new logic is in the pure module so it tests without React Native or a real socket. Manual airplane-mode smoke on a real device is deferred to a device-test pass — the harness can't toggle a radio.

### Fixed (Epic A — desktop battery, #382)

- **Idle bridge now pauses the worker when the user walks away (#382 P2.2).** Pre-fix, `apps/desktop/src/idle-bridge.ts` fired idle/active transitions into a console log + an `idle-state-changed` IPC nothing listened to — dead code. The bridge correctly detected idle (via `powerMonitor.getSystemIdleTime` + lock/unlock/suspend/resume events) but no consumer used the signal, so the worker kept polling Gmail and generating decisions while the user was away from the laptop. New `apps/desktop/src/idle-pause-controller.ts` is a side-effect-injected state machine: on `idle` it calls `serviceManager.pause()` and remembers it was the one that paused; on `active` it `resume()`s only if it had been the one to pause (so a user-initiated kill-switch pause survives an idle/active cycle without being silently un-done). New `apps/desktop/src/desktop-preferences.ts` adds an electron-store-backed `idlePauseEnabled` setting (default ON) — the controller short-circuits to `noop` when the user has disabled the feature, and a runtime toggle off while auto-paused triggers an immediate resume so the preference change has a visible effect. Manual pause/resume via the kill switch or tray clears the controller's auto-paused flag (`onManualPauseChange`) so the next active transition doesn't override the user. New `get-idle-pause-enabled` / `set-idle-pause-enabled` IPC + matching preload methods; the existing `pause-twin` / `resume-twin` handlers now also call `onManualPauseChange()`. Settings page gains a Desktop-section toggle ("Pause background work when idle") that round-trips through the IPC and shows a success toast (*"Will pause when idle"* / *"Always running"*). Eleven new vitest cases cover the controller's transitions (idle when enabled / disabled / already paused; active when auto vs. manual; setting disabled mid-idle; idempotency on repeated events; manual pause/resume clearing the flag). Manual smoke against a real 5-minute AFK on a packaged build deferred to a packaged-build pass — the controller plus the IPC contract are what's testable in CI. With this PR landed, the desktop app actually honours its "pause when idle" promise; battery savings on a closed-lid / walked-away laptop are real instead of theoretical.

### Fixed (Epic A — desktop first-launch UX, #383)

- **First-launch splash shows a real progress bar driven by tar extraction (#383 P2.3).** Pre-fix, `apps/desktop/src/splash.html` rendered a spinner + "Starting up…" while `service-manager.ts` ran a stdio-inherited `tar -xzf apps.tar.gz` against the ~45 MB embedded bundle — 5–15s of zero-feedback wait that read as "is this app frozen?". New `apps/desktop/src/extraction-progress.ts` is a pure helper that maps `(filesExtracted, totalFiles)` → `{ percent, phase, label }` with three phases (`unpacking` 0–29%, `almost-ready` 30–99%, `ready` 100%) and the corresponding human labels. Service-manager pre-counts entries via `tar -tzf apps.tar.gz` (cheap — single gunzip pass, ~500ms), then runs `tar -xzvf` with stdout piped and counts newlines (one per extracted member) to drive the progress. IPC is throttled to "percent changed" so a 10 000-file tarball fires at most 100 events. A new `setExtractProgressHandler` on ServiceManager lets `main.ts` register a handler that forwards each event to the splash window via `webContents.executeJavaScript('window.setExtractionProgress(p, "label")')` — no preload script on the splash needed, since the splash already loads its own inline JS. The terminal state (100% / "Ready!") is owned by `extractionDone()` and only emitted after `tar` exits 0, so a still-flushing process can't land the user on a black screen prematurely. The `splash.html` rewrite swaps the spinner for a gradient progress bar with an indeterminate shimmer animation when no events have arrived yet (degenerate tarball or counter failed → bar stays at 0% but the shimmer conveys liveness). Eight new vitest cases lock the helper edge cases (negative counts clamp to 0, overshoot caps at 99%, `totalFiles=0` falls back to the unpacking 0% state with the indeterminate label, non-finite inputs handled, terminal `extractionDone()` returns 100%). Manual smoke against a packaged build on a fresh-install machine is deferred to a follow-up packaged-build pass since the harness can't drive a real Electron splash window — the pure helper + the tar wiring + the splash DOM contract are what's testable in CI.

### Fixed (Epic A — desktop UX, #381)

- **First window-close fires a one-shot toast explaining the tray (#381 P2.1).** Pre-fix, `apps/desktop/src/main.ts` close handler called `event.preventDefault(); win.hide()` so the app kept running in the tray — correct behaviour for a background daemon, but invisible to a user who reached for ⌘W expecting the app to quit. They saw the window vanish, assumed the app was dead, and the worker kept polling Gmail and burning battery in silence. The "Quit SkyTwin" item already lives in the tray menu (`apps/desktop/src/tray.ts:195`); the gap was discoverability, not the affordance itself. New `apps/desktop/src/first-close-toast.ts` is a pure state-machine helper: `shouldShowFirstCloseToast(state)` returns true exactly once per session, flipping the state object on the first call. The Electron wiring in `main.ts` calls the helper inside the close handler and, on the first hit, sends a `show-first-close-toast` IPC event to the renderer before hiding the window. The renderer subscribes via the new `window.skytwinDesktop.onFirstCloseToast(listener)` API exposed in `preload.ts` and surfaces a friendly 8-second info toast: *"SkyTwin keeps running in the background so it can act on signals. Quit fully from the menu bar icon."* The toast uses the existing `showToast()` helper from `apps/web/public/js/toast.js` so the styling matches every other toast in the app. Suppression is session-scoped (cross-session re-shows are intentional — the hint should resurface for someone who quits and relaunches a week later having forgotten the tray semantics); no localStorage write, no preferences plumbing. Three new vitest cases lock the state machine (first call returns true + flips, subsequent calls return false, distinct state objects model distinct sessions). Manual smoke across platforms (macOS + Windows + Linux) is deferred to a packaged-build pass since the harness can't drive a real Electron window — the pure helper plus the IPC contract is what's testable in CI.

### Added (Epic B — launch video, #414)

- **Deterministic demo-video recorder (#414) — every dep local-first, every step reproducible.** New `scripts/demo/` standalone package builds the 5-minute launch video that the Google OAuth restricted-scope review (#351) is waiting on. The reference depobot pipeline used Selenium + ElevenLabs; this implementation uses **Playwright + Piper TTS via the existing `/api/voice/synthesize` endpoint + ffmpeg** — zero new external API keys, zero new runtime services. The Piper voice model is the same one already shipped via `@skytwin/embedded-llm` for the in-app voice loop, so the launch video and the on-device user feature share one binary, one model, one set of failure modes. Pipeline: `scripts/demo/timeline.json` describes the 7-step walkthrough (mirroring `docs/demo.md`) as cue points with Playwright actions per step; `scripts/demo/src/record.ts` boots Chromium at the timeline's viewport, pre-seeds the sample-profile userId via `addInitScript` so the wizard's "Try with a sample profile" button is a one-click skip rather than a five-screen dance, walks each step's actions while a parallel screenshot loop captures at 1 fps, then hands off to `assemble.ts` which uses ffmpeg to build the silent H.264 mp4 and mux narration WAVs at their cumulative cue offsets (one `adelay` per step + an `amix` over all clips). Narration is sha256-cached by `(voice, text)` so a copy edit only re-synthesises the changed lines (~5s on a warm Piper). Pre-flight checks the dev server is reachable + the sample profile is seeded before launching Chromium — a forgotten `pnpm dev` fails in seconds rather than after a 60-second screenshot loop. New top-level `pnpm demo:install` / `demo:record` / `demo:narrate` shortcuts; `scripts/demo/` is deliberately NOT a workspace package (uses `--ignore-workspace` on install) so its Playwright dep doesn't pollute the monorepo's install graph. `scripts/demo/README.md` covers setup, recording, editing the script, sub-commands, environment knobs, and why-not-Selenium-or-ElevenLabs. The output is byte-deterministic given the same `timeline.json` + same Piper voice model + same seeded sample profile + same Playwright/Chromium minor — all four pinned via lockfile in CI. Closes the long-pole tooling dependency on #351 + unblocks the launch video the `docs/launch-plan.md` Tier 1.4 deliverable was waiting on (which was already half-shipped via the text walkthrough in `docs/demo.md`).

### Fixed (Epic B — auto-update, #370 partial)

- **Auto-update `feedURL` is no longer dead config; placeholder `.local` default removed (#370 partial).** Pre-fix, `apps/desktop/src/auto-update.ts` defined `feedURL: string` in `AutoUpdateConfig`, defaulted it to `https://updates.skytwin.local/` when neither config nor env var was set, and then never plumbed it through to `electron-updater` — the field was decorative AND the placeholder it carried would have caused DNS resolution failures if it had been wired up. Meanwhile the real update path was relying on the publisher block in `apps/desktop/package.json` (`provider: github`, `owner: jayzalowitz`, `repo: skytwin`) without anyone reading that as the source of truth. Now: `AutoUpdateConfig.feedURL` is `string | null`; `resolveFeedURL()` returns `null` when nothing is set (signalling "leave electron-updater alone — the GitHub Releases publisher takes effect"); and `ElectronUpdaterBackend` calls `autoUpdater.setFeedURL({ provider: 'generic', url })` ONLY when the override is non-null. Self-hosters who want to point at their own update server set `SKYTWIN_UPDATE_URL=https://...` on the desktop process; the value flows through the controller into the backend and overrides the GitHub publisher. The `.local` placeholder is gone. Test fixtures updated to use `null` by default; two new tests lock the new behaviour (`returns null when neither config nor env var is set`, `picks up SKYTWIN_UPDATE_URL when set`). 31 auto-update tests pass. Full end-to-end verification against a signed `.dmg` is tracked under #368 and depends on Apple Developer cert acquisition; this PR closes the dead-config half of #370 so the next signed build can ship updates correctly with no further code change.

### Changed (docs — technical-spec API sync)

- **`docs/technical-spec.md` API section synced to what actually shipped.** The endpoint reference was on the pre-consolidation `/api/v1/...` namespace and missing every endpoint that landed during Tier-2 polish. Updated to match `apps/api/src/index.ts` post-Tier-2 — most routes live under `/api/...` (no `v1` prefix); the `/api/v1/...` namespace is reserved today for the Ask, Briefings, and Skill-Gaps routers that pre-dated the API consolidation. Documented every endpoint that landed in this run: `DELETE /api/users/:userId?confirm=delete-my-data` right-to-erasure (#376), `PUT /api/users/:userId/autonomy-pause` + `GET /api/users/:userId/autonomy-state` for the per-user pause banner (#379), `GET /api/twin/:userId/progress` for the trust-tier UI (#373/#396), `GET /api/activity/:userId` unified timeline (#391), `POST /api/sessions/pair/consume` short-lived pairing exchange (#385), `GET /api/connectors/:userId/status` OAuth health (#377), `GET /api/health/live` + `GET /api/health/ready` (#378) including the pool-stats 503 path, `GET /metrics` Prometheus exposition (#392). Also fixed pre-existing drift in the Decision + Twin + Ask endpoint blocks (Decision API was still on the `/api/v1/` namespace; Twin block claimed a non-existent `/profile` suffix + `/history` endpoint; Ask path was inverted — actual route is `POST /api/v1/twin/ask/:userId`); the `/insights` description was corrected from "reset learned patterns" to the actual scoped-removal behaviour (removes or corrects one `(domain, key)` preference per call). Each block cites the source file so a future drift is visible at the spec line. Documentation-only — no code change.

### Changed (docs — safety-model sync with shipped Tier-2 fixes)

- **`docs/safety-model.md` synced to what actually shipped.** The defense-layers section ended at Layer 6 (Approval Routing) and didn't document the three new layers that landed during Tier-2 polish: Layer 7 — Global pause + per-user pause (#379), Layer 8 — Right to erasure (#376), Layer 9 — Access audit log (#393). Each new entry follows the existing layer template: what the layer is, what it gates, where the code lives, what it can/can't do, and how it interacts with the layers above and below. The trust-tier-progression section also added the time-in-tier floor (#373) as the third gate alongside `consecutiveApprovals` and `minApprovalRatio` — the engine waits 24h / 72h / 168h before lifting the tier when callers populate `ApprovalStats.hoursInCurrentTier`. Pointers to the shape-lock test (`promotion-thresholds-shape.test.ts`) and to the cascade E2E test (`cascade-cleanup.e2e.test.ts`) so a future reader can verify the doc matches the engine. Documentation-only — no code change.

### Fixed (Epic A — onboarding, #389)

- **"Let SkyTwin learn from your computer" button is disabled with a "Coming soon" badge until the idle-miner wiring lands (#389).** Pre-fix, clicking the third welcome-screen choice transitioned the wizard through `computer_choice` → `recipe_preview` and dropped the user on the dashboard with **zero signals enabled** — the `idle_miner_poll` step doesn't actually enable the miner, and the desktop idle bridge in `apps/desktop/src/idle-bridge.ts` is dead code today (tracked by #382). Users who picked this path were silently routed to a no-op and then wondered why nothing was happening. Per the #389 acceptance-criteria option (b), the button in `apps/web/public/js/pages/onboarding.js` is now `disabled` + `aria-disabled="true"` with a "Coming soon" badge inline with the title, dimmed styling, a `title` tooltip, and copy that links readers to the tracking issue ([#389](https://github.com/jayzalowitz/skytwin/issues/389)) so the wiring status is visible. The email + about-me paths are unchanged. Option (a) — actually wiring up the idle miner — is tracked under the same issue and depends on #382 (idle-bridge wire-up) landing first; this is the safe interim that keeps cold-loaders from completing onboarding into a silent dead-end.

### Added (Epic — polish, #397)

- **Demo script: five minutes, seven steps (#397).** New `docs/demo.md` walks a viewer through the SkyTwin happy path end-to-end in ~5 minutes: cold-load the dashboard → orient on the empty state → connect Gmail (or use the sample profile) → approve a decision → reject one with feedback → visit Settings (trust tier + spend caps + delete-my-data) → hit the panic button. Each step has a goal, a target time, and an explicit "what this proves" callout the reader can use as the talking point. Includes a time budget table (5:00 total) with compression guidance for steps to shorten if running long, plus a recording-the-launch-video section with the practical bits (1280×800 Chrome window, sample profile not real Gmail, headset mic, hard cut at five minutes). The repo's existing demo stills under `docs/screenshots/` are the baseline; a fresh capture run against the post-Tier-2-polish UI is tracked as a follow-up so the launch video uses captures of the actual shipped UI rather than an early-mockup that's already drifted. This file doubles as the launch-video script the `docs/launch-plan.md` Tier 1.4 deliverable was waiting on.

### Added (Epic — polish, #398)

- **Monetization sentence in README + homepage (#398).** Pre-fix, neither the README nor the homepage addressed "how does this stay alive?" — silence breeds paywall fear and "this is going to get rugpulled" suspicion for the launch-day stranger reading the README cold. New "How this stays alive" section at the bottom of both surfaces says, verbatim: **"Free and open source forever for personal use. Future Team and Hosted tiers are planned for organizations that need shared policies, audit logs, or managed infrastructure. Personal features will never be paywalled."** No specific prices, no per-tier feature lists, no commitments beyond the shape — overpromising on a backlog we haven't shipped is the easiest trust to lose, and committing to a $/mo number we'd have to walk back is worse than the silence we had. The homepage version invites readers who think they're in the Team/Hosted target audience to open an issue describing what shared-team policy or audit features their org needs so the spec gets shaped by real use cases, not internal guessing.

### Fixed (Epic D — privacy, #375 partial)

- **Env-driven LLM provider chain is now local-first by default (#375 minimal slice).** Pre-fix, the chain ordering in `apps/api/src/lib/llm-client-factory.ts` was `ANTHROPIC → OPENAI → GOOGLE → OLLAMA → EMBEDDED` — a single cloud key in the env made the cloud provider first-call on every caller that resolved its LLM client through `getLlmClientFromConfig()` (today: capability-suggestion paths in `apps/api/src/routes/capabilities.ts` plus any future singleton-factory caller). The privacy policy promised "your data stays local"; the default contradicted that the instant a user configured Anthropic for "smarter decisions" on those paths. `buildProviderChain` now splits providers into local (embedded + ollama) and cloud (anthropic + openai + google) buckets and emits `local || cloud` by default. New `SKYTWIN_LLM_PRIORITY=cloud-first` env var puts cloud providers ahead of local — explicit consent gate, env var itself is the audit trail. Each bucket keeps its own canonical sub-order (cloud is always anthropic → openai → google, local is always embedded → ollama, regardless of priority flag). Unknown / typo values fall through to local-first (a typo must not silently escalate to cloud). Case-insensitive on the value. New `buildProviderChain` export (previously private) so the ordering invariants are unit-testable. **Scope note:** the decision-ingest pipeline (`apps/api/src/routes/events.ts`) and the assistant/lifebooks/draft-email paths construct their own LlmClient from `aiProviderRepository.getEnabledForUser`, ordered by the per-user `ai_provider_settings.priority` column — those paths are NOT changed by this PR. The user-facing toggle UI that unifies both ordering paths is tracked as a follow-up to the same issue. 8 new tests in `apps/api/src/__tests__/llm-client-factory.test.ts` lock the default order, the cloud-first opt-in, the typo fallback, case-insensitivity, empty-env behaviour, and canonical sub-orders when only one bucket is present. `docs/privacy.html` updated with the precise scope + the opt-in env var as a consent gate.

### Fixed (Epic — security, #385)

- **QR pairing token now has a 5-minute TTL + single-use enforcement (#385).** Pre-fix, `POST /api/sessions` minted a **7-day session token** and embedded it directly in the QR URL — a screenshot of the QR (shared in Slack, posted in a tweet, taken over your shoulder, scrollback of a Zoom screen-share) granted indefinite pairing AND multiple devices could redeem the same code in parallel because there was no single-use semantic. That's a 7-day window to redeem somebody else's credential. New `apps/api/src/pairing-token-store.ts` is an in-process map of `(token → { userId, deviceName, expiresAt, consumedAt })` with a 5-minute TTL. `POST /api/sessions` now mints a short-lived pairing token (same response shape, the `token` field is now the pairing token not the session; `qrUrl` uses `pairToken=` to signal the new semantics). New `POST /api/sessions/pair/consume` exchanges a valid pairing token for a real 7-day session token AND marks the pairing token used; a second redemption returns `409 code_already_used`, an expired token returns `410 code_expired`, an unknown token returns `404 code_not_found`. Web mobile-entry path in `apps/web/public/js/app.js` detects `pairToken=` and calls consume; legacy `token=` URLs from a pre-deploy QR keep working for backward compat. Storage is in-process Map (5-minute window makes loss-on-restart acceptable — user generates a new code); multi-instance API would need to lift this to CRDB the same way #58 lifted PKCE verifiers, tracked as a follow-up. 10 store tests in `pairing-token-store.test.ts` lock the security contract (TTL, replay, unknown/empty handling, device-name preservation). 8 route tests in `sessions-pair-route.test.ts` lock the wire contract (5-min TTL on the QR, consume returns a fresh session, replay → 409, expiry → 410, unknown → 404, device-name override). Mobile error-message UX (`"Code expired"` / `"Already used"` banners) is tracked as a follow-up on the mobile client; today the web mobile-entry path surfaces them via the existing toast.

### Added (Epic — polish, #391 follow-up)

- **Activity tab UI on top of the #391 endpoint.** New `#/activity` page in `apps/web/public/js/pages/activity.js` consumes the `GET /api/activity/:userId` endpoint shipped in the prior PR and renders the unified signal / decision / feedback timeline. Time-range chips for 1h / 24h (default) / 7d / 30d use a singleton document-level click handler hash-gated on `#/activity` per the CLAUDE.md "Frontend Event Handling" convention — no inline event handlers. Each event row shows a kind badge (signal / decision / feedback), an optional domain badge, a relative timestamp, and the synthesised summary; decision and feedback rows expose an "Explain →" link that deep-links into the existing decisions page focused on the row's `decisionId` so users can drill into the ExplanationRecord. Empty state copy adapts to the chosen range — "nothing in the last hour, try a longer window" vs. "your twin's been on standby, connect a service" on the 30d window. Sidebar nav gets a new "Activity" entry between "What happened" and "What I've learned." Hash query-param round-trip (`#/activity?hours=168`) means a back-button or bookmark restores the user's selection.

### Added (Epic — polish, #391)

- **Recent-activity timeline endpoint (#391 backend slice).** New `GET /api/activity/:userId?hours=24&limit=200` returns a unified, newest-first feed of signals + decisions + feedback merged into one chronological list — the data backing the future Activity tab the dashboard is missing today. Each event is shaped as `{ id, kind: 'signal'|'decision'|'feedback', at, summary, domain?, decisionId? }` so the future UI can render the timeline + drill into the ExplanationRecord via `decisionId` with no extra lookup. Three underlying repository fetches run in parallel via `Promise.allSettled`; a CRDB blip on one source returns partial results (best-effort union — better to show "2 of 3 timelines" than fail the whole tab). Time window clamped to `[1h, 720h (30d)]`, limit clamped to `[1, 500]` so a malformed query param can't blow up the response shape. Gated by the existing `sessionAuth + requireOwnership + bindUserIdParamValidator` triple — a malformed userId rejects with `400 invalid_user_id` before any repo runs. The frontend Activity tab + filter UI + drill-down link are tracked as follow-ups under the same issue — shipping the endpoint first because that's the load-bearing piece every UI design will share. 7 new route tests in `apps/api/src/__tests__/activity-route.test.ts` lock the wire shape: empty-user default, newest-first merge, lookback-window drop, hours/limit clamp on both ends, partial-result resilience, malformed-userId rejection, row-cap on oversized union.

### Added (Epic D — privacy, #393)

- **Access-log foundation: table + repository + credential-vault instrumentation (#393).** Pre-fix, a worker that decrypted a user's OAuth tokens left no breadcrumb — no forensic trail for insider threat or lateral movement, no way for the user to see "what touched my data and when." New `access_log` table (migration `062-access-log.sql`) with `(id, user_id, actor, action, resource_type, resource_id, request_id, occurred_at)`, indexed on `(user_id, occurred_at DESC)` for cheap per-user time-range scans. Append-only by design — no update/delete API surface, and the row cascades on user purge (#376 / #413) so the right-to-erasure flow stays intact. New `accessLogRepository.record()` and `.findByUser()` in `@skytwin/db`. New `AuditLogPort` interface in `@skytwin/connectors` wired into `DbTokenStore.setAuditLog(port, actor)` — every successful credential-vault decryption now emits one `action: 'decrypt_oauth_token'` row through the sink. The plaintext-fallback paths (vault not unlocked, no token at all) do NOT emit — those aren't privilege actions. Worker process wires the sink via `accessLogRepository.record` with `actor: 'worker'`. Critical contract: the audit log is fire-and-forget — a logging failure NEVER blocks or denies a legitimate decrypt, it gets caught + warn-logged at the call site. 4 new repo tests in `packages/db/src/__tests__/access-log-repository.test.ts` cover insert column order, optional-field coalescing, sort order, and the `[1, 1000]` limit clamp. 6 new tests in `packages/connectors/src/__tests__/db-token-store-audit.test.ts` lock the security contract: emit on successful decrypt, skip on plaintext fallback, skip on null token, swallow async + sync sink errors, no-op when no port attached. API-route instrumentation (every sensitive read writes a row) and the Settings → "Your access log" page are tracked as follow-ups under the same issue — shipping the worker-decryption path first because that's the highest-value forensic surface today.

### Added (Epic — operations, #392)

- **Prometheus `/metrics` endpoint on the API (#392).** Self-hosters previously had no way to alert on pool exhaustion or process health without writing custom CRDB queries — the metrics existed (`getPoolStats`, `process.memoryUsage`) but weren't exposed for scraping. New `formatPrometheus` helper in `@skytwin/observability` renders Prometheus text-format exposition (HELP / TYPE / value triples, alphabetical-key label sorting, spec-correct escape rules for backslash / quote / newline, `NaN` / `+Inf` / `-Inf` per the wire format). Hand-written rather than depending on `prom-client` because we only need text exposition — one less dependency for the security-conscious self-hoster. New `GET /metrics` route on the API exposes pg pool stats (`skytwin_db_pool_total`, `_idle`, `_waiting` — the last one is the canary for the #378 saturation class of bug) plus process uptime / heap / RSS. Read-only and unauthenticated by design (Prometheus scrapers don't carry sessions); the payload contains zero per-user data, so there's nothing to leak. Self-hosters who want auth can put the API behind a reverse proxy that filters `/metrics`. Circuit-breaker state, decision rate, and worker poll latency live in the worker process and need a cross-process scrape strategy — explicitly deferred to a follow-up. 11 new unit tests in `packages/observability/src/__tests__/prometheus.test.ts` lock the wire format (spec compliance, label sorting, escape rules, NaN/Inf, empty payload), 6 new route tests in `apps/api/src/__tests__/metrics-route.test.ts` lock the API surface (Content-Type, series names, pool-saturation passthrough, null-pool defaults). New `docs/operations.md` explains the endpoint + alert recommendations; new `docs/grafana/skytwin-overview.json` is a 6-panel starter dashboard operators can import in one click.

### Added (Epic — polish, #390)

- **Onboarding wizard now resumable across tab close (#390).** Pre-fix, closing the browser mid-wizard restarted from screen 1 on next visit — annoying for users with multi-step setups, doubly annoying for users who had to ctrl-c the desktop dev server between consent and callback. Now: every `transitionTo(screen)` writes a small `skytwin_onboarding_state` payload to localStorage (the screen name, `hasLlmProvider`, picked recipe, and a `savedAt` timestamp — no conversational answers or dependency-graph state). On next `renderOnboarding` call, if a saved payload exists for a screen other than `welcome`, the wizard renders a "Pick up where you left off?" gate with two buttons: **Resume** (jumps to the saved screen) or **Start over** (clears the saved state and goes back to screen 1). The payload is versioned (`ONBOARDING_STATE_VERSION = 1`) so future schema changes can bump the version + drop stale payloads gracefully. `finishWizard()` and the `isFirstRun: false` branch both clear the state, so a successful run + a re-completion-elsewhere both leave a clean slate for the next first-run visit (e.g. after a delete-my-data flow from #376). New `KEY_ONBOARDING_STATE` + `ONBOARDING_STATE_VERSION` exports in `storage-keys.js` make the key auditable from the centralised registry rather than buried inline.

### Changed (Epic — polish, #394)

- **Single skeleton on capability-detail page (#394).** Pre-fix, `renderCapabilityDetail` in `apps/web/public/js/pages/capability-detail.js` painted a single `"Loading capability…"` line, then ran three fetches **sequentially** (server → skills → policy) before snapping the full multi-card layout into place. End-to-end latency was the sum of three round-trips and the user saw a 1-line placeholder then a sudden 8-card paint. Now: a three-section skeleton (header / Skills / Spending guardrails stubs with a `.skeleton-pulse` shimmer) renders immediately so the page structure is on-screen the instant the user lands. The three fetches fire in parallel — server is awaited first on its own so its rejection surfaces immediately without waiting for slow/hung skills or policy fetches; skills + policy run in the background and are awaited after server resolves (best-effort with empty-state fallback). New `.skeleton-pulse` CSS class with a `prefers-reduced-motion` opt-out — reusable for future skeleton work elsewhere on the dashboard.
### Added (Epic — polish, #396)

- **Promotion criteria copy in Settings (#396).** Pre-fix, the Settings tier card explained the tiers in plain English ("Just watch", "Ask me first", "Handle small stuff", …) but never told the user what it actually took to move from one to the next. The criteria — N consecutive approvals, ≥X% approval ratio, ≥Y hours in tier — were enforced by `deterministicPromotion` in `packages/policy-engine/src/trust-tier-engine.ts` against `PROMOTION_THRESHOLDS` from shared-types, but the user only learned the floor existed when their next-tier offer didn't appear and they wondered why. New expandable "What does it take to move up to <next tier>?" section under the tier selector renders three bullet lines pulled from a `PROMOTION_TIER_INFO` constant in `apps/web/public/js/pages/settings.js` that mirrors `PROMOTION_THRESHOLDS` exactly. `moderate_autonomy` and higher get a different copy explaining that the next jump (Full autopilot) is explicit opt-in, not automatic. New test in `packages/policy-engine/src/__tests__/promotion-thresholds-shape.test.ts` locks the source-of-truth values (10/0.8/24h, 20/0.85/72h, 50/0.9/168h) so any drift in `PROMOTION_THRESHOLDS` surfaces as a failing test pointing at the now-stale Settings copy in the same PR.

### Added (Epic D — privacy, #361)

- **Right-to-erasure / "Delete everything about me" endpoint + UI (#376).** Pre-fix, a user who connected their Gmail, let the twin learn for a week, and decided "this isn't for me" had no way to delete what the product had accumulated. Twin profile, decision history, memory pages, knowledge triples, episodic memories, preferences, OAuth tokens, spend records — all of it remained indefinitely with no path short of `psql` and a list of 30+ tables. Privacy-policy gap (GDPR Article 17), trust gap ("won't trust the app with new data"), and recovery gap ("can't start over after training a bad twin") in one. New `DELETE /api/users/:userId?confirm=delete-my-data` route in `apps/api/src/routes/users.ts` (gated by the existing `sessionAuth + requireOwnership` middleware so user A cannot delete user B). New `userPurgeRepository.purgeUser()` in `packages/db/src/repositories/user-purge-repository.ts` runs the entire delete inside `withTransaction` (CRDB serializable) — a failure anywhere rolls back, no half-deleted state. Dependency order: leaves first (`execution_results`, `execution_events`, `execution_plans`, `explanation_records`, `decision_outcomes`, `candidate_actions`, `twin_profile_versions`, `knowledge_triples`) then the final `DELETE FROM users` whose cascade through the 32 user_id FKs (now ON DELETE CASCADE per migration 061 from #413) collapses the rest of the footprint in one statement. Returns per-table row counts so the Settings UI can surface "twin profile (1), decisions (147), preferences (23) — 1,021 rows total." New Settings → "Delete everything about me" card with a two-stage confirm (window.confirm → window.prompt "type DELETE"), an `?confirm=delete-my-data` query-param defence at the route layer to block a stray DELETE in the wrong env, and a localStorage purge + reload after success. Privacy-policy page (`docs/privacy.html`) updated with the cascade list + a pointer to `user-purge-repository.ts` as the source of truth. 6 new unit tests in `packages/db/src/__tests__/user-purge-repository.test.ts` (dependency order, transactional wrap, rollback on error, parameterised-only — no SQL injection vector) and 5 new route tests in `apps/api/src/__tests__/users-delete-route.test.ts` (confirmation gate, success-with-counts, 404 when user already gone, error propagation). Builds on #413 — without cascade FKs in place this would have been either a 30-statement manual purge or a runtime FK error on the first child row.

### Changed (Epic — polish, #395)

- **Centralised money formatter (#395).** Replaced 11 hand-rolled `(cents / 100).toFixed(2)` display sites scattered across `apps/web/public/js/{pages,components}` and 4 in `packages/decision-engine/src/risk-assessor.ts` with a single `formatMoney(cents, opts?)` helper. Backed by `Intl.NumberFormat`, which both Node 20+ and every supported browser implement natively (no new dependency). The server-side helper lives at `packages/core/src/format-money.ts` and is re-exported from `@skytwin/core`; the browser-side mirror at `apps/web/public/js/format.js` follows the same contract. Defensive on every edge case the old `.toFixed(2)` calls handled silently (or incorrectly): NaN / Infinity / -Infinity → `$0.00` (renders the smallest sane value so the UI never breaks), non-integer cents are rounded to the nearest integer first (so a stray `199.7` doesn't surface as `$1.997`), invalid locale or currency code falls back to `en-US`/`USD` via a `try`/`catch` around the `Intl` call. Pure refactor — output strings for the default `en-US`/`USD` locale are identical to the pre-fix renders. The two `<input type="number">` sites in Settings (the spend-cap inputs) and the equivalent two in capability-detail.js are deliberately left as plain `(cents/100).toFixed(2)` because `<input type="number">` rejects locale-formatted strings. 12 new tests in `packages/core/src/__tests__/format-money.test.ts` cover en-US / en-GB / ja-JP locale-aware rendering plus every defensive branch. Scaffolds the seam future i18n work can hook into without touching every call site again.

### Added (Epic D — reliability, #361)

- **OAuth re-auth user-facing surface (#377).** Pre-fix, when Google revoked SkyTwin's refresh token (user clicked "Remove third-party app" in their Google account, or inactivity aged the token out), the worker correctly tripped the per-user circuit breaker and stopped hammering Google's token endpoint — but the dashboard kept rendering "Listening" and the user noticed days later when "did you get my email?" surfaced the silent breakage. This PR adds the single missing piece: a user-facing signal that something needs re-auth. New `connector_health` table (migration `060-connector-health.sql`) with one row per `(user_id, connector_name)` records `status: 'connected' | 'needs_reauth' | 'disabled'` (enforced by a DB-level CHECK constraint), `error_code`, and `last_success_at` / `last_failure_at`. New `connectorHealthRepository.upsert` writes from the worker on every poll outcome — `needs_reauth` on the existing `OAuthRefreshError.permanent === true` branch (alongside the circuit-breaker force-trip), `connected` per-connector on success so a multi-connector user with one bad connector doesn't have a working one stuck. The repo uses `now()` (DB time, not application time) so multi-node deployments don't get clock-skewed `updated_at` values. New `extractErrorCode()` parses the Google `error` field out of the actual `OAuthRefreshError` message format (`Google OAuth token refresh failed ...`) so the banner can render conditional copy ("invalid_grant" → "access was revoked or expired"). New `GET /api/connectors/:userId/status` (apps/api/src/routes/connectors.ts) returns `{ connectors: {name: {status, errorCode, lastSuccessAt, lastFailureAt}}, anyNeedsReauth }`. New amber chrome banner (sticks below the red kill-switch banner if both fire) reads from the endpoint on every `navigate()` + every 60s and shows a single "Reconnect" CTA that jumps to `#/connect-gmail`. Banner is not dismissible — the worker has stopped doing work for this user and they need to fix it. CLAUDE.md launch criterion: "silent breakage that masquerades as normal operation" is the single worst class of bug for a delegated-action product; this closes it.

### Added (Epic D — safety, #361)

- **Global kill switch / "pause everything" (#379).** Two coordinated levers + an un-missable chrome banner give every install a panic button that does NOT require redeploying the worker. Lever 1 — operator env var: `SKYTWIN_AUTO_EXECUTE_DISABLED=true` on the API/worker process is read once at `PolicyEvaluator` construction and routes every `evaluate()` call to `{ allowed: true, requiresApproval: true }` regardless of trust tier, autonomy settings, or per-policy rules. The check sits AHEAD of the trust-tier gate and the injection guard so no downstream allow path can bypass it. Actions still land in the Approvals queue — they just don't auto-execute. Lever 2 — per-user toggle: `autonomy_settings.paused = true` (set via new `PUT /api/users/:userId/autonomy-pause`) triggers the same escalation per-user. Operator pause reason wins when both are set so the chrome copy reflects who set the pause. Lever 3 — banner: a sticky red strip across every page reads from new `GET /api/users/:userId/autonomy-state` (refreshed on every `navigate()` + every 30s), with separate operator + user lines and a Resume button that only appears for the user-pause line (the operator pause can only be cleared by unsetting the env var). Settings page gains a "Pause auto-execution" card with confirmation modal on both transitions and an optional free-text reason field. Coexists with the existing "Pause everything (demote to observer)" button — different lever (tier demotion vs true execution gate). Five new policy-engine tests cover the operator-paused, user-paused, both-paused (operator wins), neither-paused regression, and `isGloballyPaused()` reporting matrix. Safety Invariant #1 (every auto-execute path went through a policy check) is structurally preserved — the new check strengthens the single funnel rather than adding a parallel path. CLAUDE.md launch-criterion #8 ("user can find a 'pause everything' button if they panic") satisfied.

### Fixed (Epic D — safety, #361)

- **DecisionOutcome carries per-candidate RiskAssessments (#412).** Same divergence-hazard class as #371 but at the in-memory persistence-shape layer. Pre-fix, `DecisionOutcome.riskAssessment` was the selected candidate's assessment only; the DB persisted per-candidate via `candidate_actions.risk_assessment` JSONB but the in-memory outcome lost that completeness. Any code path that re-selected a candidate post-decision (manual override from the approval queue, a future "swap candidate" UX, a bug) left `outcome.riskAssessment` stale relative to `outcome.selectedAction` — the execution-router's actionId-match backstop catches the mismatch only after a wrong-tier adapter has already been picked. Fix: `DecisionOutcome` gains an optional `allRiskAssessments: RiskAssessment[]` field (optional for backward compat with pre-#412 test fixtures and the proactive-evaluator synthetic outcomes), populated from the per-candidate `assessments` Map the decision-maker already builds in step 4. New `getAssessmentForAction(outcome, actionId)` helper in `packages/decision-engine/src/decision-helpers.ts` prefers the per-candidate snapshot, falls back to the legacy convenience field only when the queried id matches the selected one, and returns null on miss (caller should fall back to `decisionRepositoryAdapter.getRiskAssessment(actionId)` for the authoritative DB read). Six new tests in `decision-helpers.test.ts` cover the matrix: id-match, miss, legacy fallback, empty, and prefer-new-over-legacy. 207 decision-engine tests pass (+6).

- **Prompt no longer asks the LLM for fields the parser discards (#411).** `packages/llm-client/src/prompt-builder.ts:81-95` used to instruct the LLM to emit `estimatedCostCents` and `reversible` on every candidate; `packages/llm-client/src/response-parser.ts:109-114` then hardcoded both to safe defaults regardless (Safety Invariant #4 — LLM must not control spend limits or reversibility). The mismatch burned tokens on output the parser threw away and, worse, created a future foot-gun: a maintainer who "wired the LLM values through" to honor the prompt would silently re-open the spend-cap bypass closed by #372. The candidate prompt no longer lists those two fields and adds a one-liner ("Cost and reversibility are determined by the policy engine, not by you.") plus an inline code comment pointing future maintainers at the response-parser invariant. Four new tests in `packages/llm-client/src/__tests__/prompt-builder.test.ts` lock the prompt + parser into alignment: the prompt MUST NOT instruct on either field, MUST explain the policy-engine ownership, and MUST still ask for the six fields the parser actually consumes. 144 llm-client tests pass.

- **Auto-execute path now uses the decision-maker's actual RiskAssessment, not a synthetic one (#371).** Pre-fix, `apps/api/src/routes/events.ts:560-576` re-derived a `RiskAssessment` from the explanation's coarse `riskTier` enum on every auto-execute, then broadcast that single tier across all six dimensions. A candidate the decision-maker assessed as HIGH on financial impact would be routed as LOW — wrong adapter, wrong risk modifier. The handler now reads `outcome.riskAssessment` (already attached by `decision-maker.ts:263`) and falls back to `decisionRepositoryAdapter.getRiskAssessment(actionId)`. If neither is available the path FAILS CLOSED: the action is escalated to manual approval rather than running with a fabricated assessment. Safety Invariant #7.

- **Approval execute path also uses the persisted RiskAssessment (#371).** `apps/api/src/routes/approvals.ts:419-434` was constructing a hardcoded `LOW`-on-every-dimension synthetic assessment with the comment "user-approved = lower risk." A user can approve a HIGH-tier financial-impact action; the dimensions don't move because a human clicked once. The route now (a) preserves the original candidate id (which `events.ts` now stamps into the approval payload), (b) looks up the persisted assessment via `decisionRepositoryAdapter.getRiskAssessment`, and (c) refuses execution with HTTP 409 `risk_assessment_missing` when the assessment is absent (preflight, BEFORE any state mutation — moved out of the deep-side-effects branch per Copilot review on PR #417). Legacy approval rows from before this PR (no `id` on the stored candidate_action JSONB) hit the same 409 and require the user to re-trigger the decision to regenerate. Test fixtures updated to include a valid UUID `id` in the stored candidate_action and a mocked `getRiskAssessment` that echoes the requested id back so the router's actionId-match invariant cannot be silently bypassed in tests.

- **LLM-generated candidates no longer silently bypass the spend cap (#372).** Pre-fix, `packages/llm-client/src/response-parser.ts:112` hardcoded `estimatedCostCents = 0` on every LLM-generated `CandidateAction` and `packages/policy-engine/src/policy-evaluator.ts` short-circuited any action with `<= 0` to "allowed." Combined: a user setting `dailyCapCents = 1000` ($10/day) saw the twin run LLM-suggested actions with combined real cost well past $10 because zero was treated as "free, auto-approve." `CandidateAction` gains a `costZeroIntent?: 'verified_zero' | 'unknown'` discriminator (`packages/shared-types/src/decision.ts`). The LLM parser emits `costZeroIntent: 'unknown'` to mark "the LLM does not get to declare its own price." `PolicyEvaluator.evaluate()` special-cases the unknown branch BEFORE the spend-limit check: it returns `{ allowed: true, requiresApproval: true }` so the candidate escalates to human approval rather than being silently dropped via a deny verdict. The `checkAutonomySettings` → `evaluate` plumbing was also fixed to propagate `requiresApproval` from autonomy-settings verdicts forward (pre-existing bug: only `!allowed` early-returned, dropping requiresApproval=true escalations on the floor — the same defect affected the irreversibility branch). Undefined intent (legacy rule-based generators in `decision-maker.ts`, `sender-aware-candidates.ts`, `draft-email-candidate.ts`, all genuinely-free) is treated as `'verified_zero'` so existing rule-based paths keep working. The pre-fix `response-parser.test.ts:163` lock-in test now asserts `costZeroIntent === 'unknown'`; four new tests in `policy-evaluator.test.ts` cover the unknown→fast-path-deny, verified_zero→fast-path, undefined→fast-path, and unknown→evaluate-escalates matrix. Persistence note in the type docstring: serializers must round-trip `costZeroIntent` or a reloaded zero-cost candidate will be treated as legacy `verified_zero` and re-open the bypass. Safety Invariant #4.

- **Trust tier promotion engine now enforces a time-in-tier floor (#373).** `packages/shared-types/src/policy.ts` `PromotionThreshold` gains `minDurationInTierHours` (24h for observer→suggest, 72h for suggest→low_autonomy, 168h for low_autonomy→moderate_autonomy). `ApprovalStats` gains an optional `hoursInCurrentTier` derived from the latest `trust_tier_audit` row. `deterministicPromotion` in `packages/policy-engine/src/trust-tier-engine.ts` rejects promotion when the floor isn't cleared even if the count threshold is, with a human-readable reasoning message ("need 24h before promotion (roughly Xh to go)"). The floor uses `Number.isFinite` so a malformed audit row (clock skew, mis-parsed timestamp yielding NaN/Infinity) cannot bypass it — pre-Copilot the `typeof === 'number'` check would have let NaN through. Pre-fix bug: a user could click "Yes, do it" ten times in the first hour and land at `suggest`, then twenty more in the next hour to reach `low_autonomy` — the ladder was climbable in a single session, exactly opposite of "earned over time." Also closes a DB-tampering vector where an attacker bumping `consecutive_approvals` could leapfrog tiers without behavioral evidence. **Scope of this PR is the engine + threshold schema only**: production API paths that build `ApprovalStats` (`/api/twin/:userId/progress`, the promotion eligibility job) do NOT yet populate `hoursInCurrentTier`, so the floor is enforced only when callers opt in. Wiring the production paths to read `trust_tier_audit` is a follow-up — until then, production retains the legacy count-only behavior. Seven new tests in `trust-tier-engine.test.ts` cover the unmet-floor and met-floor cases at each tier, the undefined-field legacy behavior, plus the NaN and Infinity bypass guards. Safety Invariant #3.

### Fixed (Epic D — reliability, #361)

- **FK cascade backfill on every legacy reference to `users(id)` (#413).** Pre-fix, 32 of the 39 user-owned tables had a FK to `users(id)` without an `ON DELETE CASCADE` clause — the schema was built up incrementally over a dozen migrations and the cascade clause wasn't standardised until the newer tables (`ai_provider_settings`, `lifebooks`, `recovery_codes`, `model_downloads`, `connector_health`) landed. The practical effect: any "delete my account" code path either had to manually enumerate every table (fragile, easy to miss a new one — exactly the foot-gun #376 will inherit) or got blocked by FK violations on the first row in `behavioral_patterns` / `signals` / `mempalace` / `sessions`. New migration `061-cascade-cleanup.sql` does the one-time DDL backfill: for each of the 32 tables, `ALTER TABLE … DROP CONSTRAINT IF EXISTS <t>_user_id_fkey; ALTER TABLE … ADD CONSTRAINT <t>_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;`. The DROP uses `IF EXISTS` so re-runs no-op; the ADD trips `42710` (duplicate_object) on re-run which the migration runner's `IDEMPOTENT_DDL_CODES` set absorbs. Constraint names follow CockroachDB's default `<table>_<column>_fkey` convention — verified across the codebase as the universal pattern (no FK to `users(id)` is hand-named). Safety net: new E2E test `packages/db/src/__tests__/cascade-cleanup.e2e.test.ts` (gated on `E2E=true`) queries `information_schema.referential_constraints` post-migration and fails if any FK to `users(id)` is still set to `NO ACTION` — catches drift if a fork ever adds a hand-named FK that the migration's conventional DROP would miss. Also exercises the cascade end-to-end on `behavioral_patterns` (one of the 32) to prove the FK semantics, not just the metadata flag, actually delete child rows. Schema-level prerequisite for #376 (delete-my-data endpoint) — without cascade, that endpoint would have either been a 30-statement manual purge or a runtime FK error on first delete.

- **API fail-fast on DB unreachable + pool stats on `/api/health/ready` (#378).** Pre-fix, three coordinated gaps compounded into a silent-failure trap: `packages/db/src/connection.ts` `Pool` had no acquire-from-pool timeout (the 21st concurrent acquire on `max: 20` hung forever), the API bound its port before any DB probe (so an unreachable CRDB looked healthy until the first user request), and `/api/health/ready` reported only "database: ok|unavailable" with no visibility into pool saturation. Three fixes: (1) `DatabaseConfig` sets `connectionTimeoutMillis: 5000` so saturated acquires fail loudly within ~5s instead of hanging — pg-pool uses this single bound for both new-connection establishment and the wait for a free slot when the pool is full; (2) `apps/api/src/index.ts` wraps `app.listen` in an async startup that arms a 30s hang detector (`process.exit(1)` with a diagnostic message), runs `healthCheck()` (`SELECT 1`), and only binds the port if the probe succeeds — mirrors the worker's pattern at `apps/worker/src/index.ts:487-491`. Orchestrators now see a non-zero exit on a dead CRDB rather than routing traffic to a zombie; (3) `/api/health/ready` adds `checks.pool: 'ok' | 'saturated'` (saturated when `getPoolStats().waitingCount > 0`) and a `pool: { totalCount, idleCount, waitingCount }` block on the response. Saturated pool returns 503 even when the DB itself is reachable, so a future canary / oncall dashboard can graph "we're 18/20 connections in use" before it becomes a customer call. SIGTERM/SIGINT before the listen() completes now closes the pool directly and exits, avoiding a null-server crash.

### Fixed (Epic A — cold-load demo unblocked, #358)

- **Onboarding modal is now dismissible.** `apps/web/public/js/app.js` + `apps/web/public/js/pages/onboarding.js`. Pre-fix, the only paths out of the first-run wizard were "complete the wizard" or "clear localStorage" — a real stranger cold-loading `localhost:3200` was trapped behind the modal in 100% of cases. The modal now closes on Esc, the new top-right "X" button, or the "Skip for now" link. Each path writes `KEY_ONBOARDED='skipped'` so reloads don't re-trap (#362). The dismissed state shows a "Sign in to see your decisions." placeholder behind the chrome with an explicit "Sign in" button (`data-action="signin-reopen"`) that clears the marker and re-mounts the wizard, so no first-visit dismiss is irrecoverable.

- **`navigate()` updates the page heading + sidebar highlights unconditionally.** The pre-fix function early-returned to `showOnboarding()` when `!currentUserId`, leaving the URL hash updating but the `<h1>` and content stuck on the wrong route (#362, #364). Chrome (heading, nav, connection status) is now updated first; `route.render` is the only step gated on `currentUserId`. Bonus: the previously-orphaned `renderLifebook` route handler now actually imports its symbol from `pages/lifebook.js`, fixing a pre-existing reference error that became reachable for unauthenticated visits via `#/lifebook/<domain>`.

- **`updateConnectionStatus()` gains an `idle` state for no-userId visits.** Pre-fix, a cold-load with empty localStorage hit the binary `{connected, disconnected}` state machine and showed a red "Reconnecting…" banner that never resolved — the SSE client was never even attempted without a `userId`, so the chrome was lying about an absent-user state being an offline one (#365). The new `idle` branch renders a grey `.status-dot.idle`, "Sign in to start" text, suppresses the banner, and skips the `_wasOffline` edge-trigger so the back-online toast can't misfire on the eventual sign-in transition.

- **"Try with a sample profile" button surfaces missing-seed state.** `apps/web/public/js/pages/onboarding.js`. Pre-fix, when the demo seed wasn't loaded the entire `#onb-tour-row` was `display:none` and the user had no way to know the option even existed — click → nothing (#363). The button now renders in a default-disabled state with "Checking sample profile…" copy, promotes to enabled when `fetchDemoInfo()` resolves `available: true`, or shows "Demo profile not loaded on this server." with a tooltip pointing at `pnpm db:seed` when the seed is missing. Successful clicks write `KEY_ONBOARDED='sample'` (not `'true'`) and redirect to `#/decisions` so the chrome can distinguish tour-mode users from completed-onboarding users for the P2 banner work. Both `hideWizard()` (onboarding.js) and `setUserId()` (app.js) now preserve any existing non-null marker so the tour-mode write isn't clobbered by the subsequent teardown calls.

- **Modal backdrop contrast meets WCAG AA.** `apps/web/public/css/styles.css`. The `.onboarding-overlay` backdrop dropped from `rgba(0,0,0,.92)` to `.60` (#366). At .92 the chrome behind the card rendered at ~8% brightness, putting sidebar text below 2:1 contrast — well under WCAG AA's 4.5:1 floor. At .60 the math works out to ~5.5:1 while keeping the modal card (opaque `var(--bg-card)` on top) as the unambiguous visual focus. The `position: relative` and new `.onb-close-x` styles support the new dismiss UI; `.signin-placeholder` styles the chrome-behind-modal fallback.

### Fixed (Epic A — security, #358)

- **API no longer leaks raw pg UUID parse errors to clients.** `apps/api/src/middleware/validate-uuid.ts` (new). Pre-fix, `curl http://localhost:3100/api/decisions/test-user` returned `{"error":"Internal server error","message":"error in argument for $1: could not parse \"test-user\" as type uuid: …"}` — leaking the underlying database engine, the prepared-statement parameter index, and the pg driver's internal error string in any `NODE_ENV=development` deployment (#367). The new module exports `UUID_REGEX`, `isValidUserId()`, and `bindUserIdParamValidator()` — the validator is wired into all 20 routers that mount a `:userId` segment (`approvals`, `ask`, `audit`, `briefings`, `crisis-modes`, `decisions`, `embedded-llm`, `evals`, `events`, `federation`, `lifebooks`, `mempalace`, `policies`, `promotion-offers`, `proposals`, `routines`, `settings`, `skill-gaps`, `twin`, `voice`). Malformed user IDs now return `400 invalid_user_id` with a safe message; pg never sees the bad value.

- **Six routes consolidated on the shared UUID regex.** `apps/api/src/routes/{memory-config,capabilities,dxt,external-agents,twin-briefings,assistant}.ts`. Each had its own local `const UUID_REGEX = /^[0-9a-f]{8}.../i;` — a divergence between any two of them would mean a UUID accepted by one route was rejected by another. All six now import `UUID_REGEX` from `middleware/validate-uuid.ts`. One source of truth.

- **Global error handler hardened.** `apps/api/src/index.ts`. Pre-fix, the response body included `err.message` whenever `NODE_ENV === 'development'` — and development is exactly where strangers first see the product. The handler now always returns `{ error: 'internal_error', message: 'Something went wrong on our end.' }` regardless of `NODE_ENV`. Full detail (message + stack) continues to land in server logs via `log.error()`. Defense-in-depth: any future pg leak that slips past the route-layer validator still can't reach the client.

- **Pre-existing tests updated to use valid UUIDs.** `apps/api/src/__tests__/{promotion-offers-routes,routines-routes,settings-ironclaw-channel}.test.ts` used `'user-1'` / `'u-1'` as test user IDs — exactly the leaky path #367 closes. Updated to canonical UUIDs. New test suites: `validate-uuid.test.ts` (13 tests) and `error-handler.test.ts` (3 tests) cover the middleware + handler contracts. Full API suite: 713 passing, 24 skipped.

### Changed

- **PKCE verifier store moved from in-process Map to CockroachDB.** `apps/api/src/routes/oauth.ts` was stashing the PKCE code-verifier in a server-local `Map<state, codeVerifier>` between `/google/authorize` and `/google/callback`. Adequate on a single long-running process, broken everywhere else: a desktop restart, a deploy, or even a dev hot-reload between consent and callback dropped the verifier and 400'd the user with "OAuth verifier expired or missing." New migration `058-oauth-pkce-pending.sql` adds an `oauth_pkce_pending(state PK, code_verifier, expires_at, created_at)` table backed by `packages/db/src/repositories/oauth-pkce-pending-repository.ts`. `remember()` is an upsert, `consume()` is a `DELETE...RETURNING` (a replayed callback can't redeem the same code twice — same replay-protection property the in-memory store had), and `sweepExpired()` fires from every remember-call so the table stays bounded even if browser tabs close mid-flow. 5 new tests in `packages/db/src/__tests__/oauth-pkce-pending-repository.test.ts`.

- **OAuth `/authorize` accepts a whitelisted `next=` deep-link target.** Adds `?next=connect-gmail` (the only currently-allowed value, defined in `NEXT_HASH_ROUTES` server-side). The value is encoded into the HMAC-signed state payload as a `next=<route>` tag, decoded on callback, and used to compose the post-OAuth redirect URL. Unknown values are silently dropped at issue time and re-validated at parse time — neither path produces a free-form redirect, so this is NOT an open-redirect surface. 5 new tests in `apps/api/src/__tests__/oauth-next-route.test.ts` cover the round-trip, whitelist enforcement, and HMAC coverage of the `next` tag (tampering breaks signature verification).

- **Onboarding wizard deep-links straight into the Gmail walkthrough after Google sign-in.** `apps/web/public/js/pages/onboarding.js`'s "Continue with Google" button now passes `next: 'connect-gmail'` through `startGoogleSignIn()`. After consent the user lands on `#/connect-gmail` with a "Calendar connected — now let's hook up Gmail" status banner (`renderGoogleConnectedBanner` in `apps/web/public/js/pages/connect-gmail.js`) above the five-step wizard, instead of dropping on the dashboard root and discovering the CTA card.

- **Structured `code` from API errors plumbed through `ApiError`.** `apps/web/public/js/api-client.js` now reads `body.code`/`body.help`/`body.docs` off non-OK responses and attaches them to `ApiError`. Pages branch on `err.code` instead of substring-matching `err.message`. 503s with a code map to a new `kind: 'config-missing'` so they're treated as user-actionable, not as generic backend failures.

- **Unset bundled `client_id` now bounces the user into the connect-gmail wizard.** `apps/api/src/routes/oauth.ts` tags its 503 response with `code: 'NO_GOOGLE_CLIENT_CONFIGURED'` + `help: '#/connect-gmail'`. The onboarding wizard detects this and redirects to the connect-gmail flow (same wizard backs both BYO Gmail and "this fork has no bundled OAuth client"). The connect-gmail wizard's final step now uses `?newUser=true` when no userId is in localStorage, so brand-new onboarding users complete the OAuth-client-setup walkthrough and get auto-created from the verified Google email on callback.

- **Desktop new-user OAuth now auto-advances the wizard** instead of stranding the user on "Continue with Google" with no signal that consent succeeded. The system-browser callback can't IPC back to the Electron app, so the wizard generates a UUIDv4 `pendingKey` client-side (`crypto.randomUUID()`); `/authorize` validates the shape and threads it through HMAC-signed state; `/callback` writes the resulting `userId` + `accountEmail` + `scopes` + `nextHash` to a new `oauth_pending_signin` table (migration 059) keyed by the pendingKey; the wizard polls `GET /api/oauth/google/pending/:key` (consume-on-read, mirrors the existing pollUntilConnected pattern) and auto-advances to `#/connect-gmail` when the row appears. Closes the previous TODO that admitted "the web flow advances via redirect, desktop currently does not." 6 new tests for the repository, 4 new tests for the UUID validator + `key=` state encoding (including a SQL-injection-shape rejection test).

  **Security model.** Possession of the pendingKey IS the authorization. The endpoint deliberately does NOT just return the userId — that would chain with the pre-existing unauthenticated `POST /api/sessions` shim (which accepts any userId from a localhost caller) to turn a leaked pendingKey into a 7-day session takeover. Instead, `/api/oauth/google/pending/:key` mints the session itself in-process and returns the token alongside the userId/scopes/nextHash. The wizard stashes the token under `KEY_SESSION_TOKEN`; subsequent API calls flow through `Authorization: Bearer …` exactly like the QR-paired mobile flow. The endpoint is per-IP rate-limited (same bucket as `?newUser=true`) and the `DELETE...RETURNING` has an explicit `expires_at >= NOW()` predicate so a poll arriving past the 5-min TTL doesn't destroy the row before `sweepExpired()` can reclaim it.

- **Tour-mode CTA promoted from buried gray link to a visible secondary button on the onboarding welcome screen** (launch-plan §2.6). Previously `#onb-tour-row` rendered as `font-size:0.82rem; color:var(--text-muted)` text that read "Explore with a sample profile instead →" — easy to miss next to three full-size primary/outline CTAs, which buried the only path that lets a brand-new visitor feel the twin before investing in OAuth setup. Now it renders as a `btn-outline btn-lg` card matching the visual rhythm of the other choices, with an "or" horizontal divider above it so the alternative-path framing is explicit. Icon (🧭) + label ("Try with a sample profile") + subtitle ("See a fully populated twin in action — no sign-in needed.") communicate the offer in one read. The conditional-on-demo-availability behaviour is preserved (CTA + divider live inside the same `#onb-tour-row` div so they appear and hide together) — non-localhost or non-dev-bypass deployments still get a clean welcome screen with no broken tour link. README's "first 60 seconds" walkthrough updated to match the new label. No behavioural change to `/api/v1/demo/{info,preview}` or `skyTwinExitTour()`.

### Fixed (post-/codex review)

- **Worker now honors the bundled `SKYTWIN_DEFAULT_GOOGLE_CLIENT_ID`** (`apps/worker/src/index.ts:resolveGoogleConfig`). The bundled-PKCE OAuth flow in the API mints tokens with no `client_secret`, but the worker was still requiring both clientId AND clientSecret and returning `null` ("credentials not configured; skipping Google connectors") for every desktop default install. Tokens existed; nothing processed them. Mirror the API's three-layer resolve (env → DB → bundled), tolerate empty `clientSecret` as the PKCE-only signal (verified `refreshAccessToken` already omits client_secret when empty), and only bail when no `clientId` is found at all. Without this fix the grandma-grade default sign-in flow saved Google tokens but never pulled a single Gmail/Calendar signal.

- **Migrations + seed now target the right CRDB instance on fresh installs** (`bin/skytwin-install setup_project`). `pnpm db:migrate` was running before `DATABASE_URL` was exported, so `@skytwin/db` fell back to its `localhost:26257/skytwin` defaults. If the user set `SKYTWIN_DB_PORT` to dodge a collision, or if `localhost` resolved to `::1` instead of the 127.0.0.1 listener on their distro, migrations silently landed on the wrong socket (or failed cryptically). Builds the URL from the same `SKYTWIN_DB_LISTEN_HOST` + `SKYTWIN_DB_PORT` source of truth that `bin/skytwin-db` already respects.

- **Desktop new-user OAuth completion now actually tears down the onboarding overlay**. The pendingKey poll's `onComplete` handler in `apps/web/public/js/pages/onboarding.js` was storing `KEY_USER_ID` + `KEY_SESSION_TOKEN` and navigating the hash, but skipping the three steps the tour-mode path does correctly (set `KEY_ONBOARDED='true'`, call `window.skyTwinSetUserId()`, and `hideWizard()`). Result: the dashboard rendered behind the still-visible onboarding modal — successful sign-in looked stuck, and a reload re-opened first-run onboarding. Mirrors the tour-mode block exactly.

- **Connect-Gmail OAuth start now uses the Electron-aware path**. `apps/web/public/js/pages/connect-gmail.js`'s final step was doing `window.location.href = data.url` directly, which inside the Electron renderer navigates the embedded WebView to `accounts.google.com` — Google rejects with `disallowed_useragent` (embedded user agents are blocked from OAuth). Refactored to call `startGoogleSignIn({ include: 'gmail', ... })`, which detects Electron via `window.skytwinDesktop` and uses `openExternal` + the pendingKey poll to complete in the system browser. `startGoogleSignIn` + `getGoogleAuthUrl` both gained an `include` parameter so the Gmail-scope opt-in survives the routing change. Web flow is unchanged (still `window.location.href` via startGoogleSignIn's web branch).

- **`bin/skytwin-db is_running` now verifies CRDB ownership before short-circuiting**. The PID-file-missing-but-port-bound fallback was returning success on ANY port listener, so an unrelated postgres / leftover docker container / apt-installed cockroach on `$DB_PORT` would make `cmd_start` skip launching the actual CRDB while still reporting "running." Migrations would subsequently fail against the wrong listener. New `is_crdb_responding()` helper runs a no-op `SELECT 1` to confirm the listener actually speaks the CRDB protocol; primary PID-file signal is unchanged.

- **Self-hoster bootstrap limitation documented**. `PUT /api/credentials/google` requires a session — the brand-new-user-with-no-bundled-client bootstrap path can't reach it on a production install with the dev bypass disabled. Default launch path (bundled client configured) doesn't hit this; flagged inline in `apps/web/public/js/pages/connect-gmail.js` and in `docs/launch-plan.md` §2.4 with the two operator workarounds (enable `SKYTWIN_DEV_AUTH_BYPASS` on localhost, or seed an admin user first).

### Fixed (Windows CI perf + reliability)

- **Windows CI was failing at the same `makensis File: failed creating mmap` error on every push.** Three runs reproduced the failure at consistent timing (~2h26 to 2h36 into the job) regardless of code changes between them. Root cause was NOT the codepath — it was Windows Defender's real-time scanner racing the freshly-written `.nsis.7z` archive: makensis is a 32-bit process that `mmap`s the .7z to embed it into the installer, and Defender's open scan handle returns a sharing violation that surfaces as the mmap fail (electron-builder #6107). The `.github/workflows/build.yml` `desktop-windows` job now runs `Add-MpPreference -ExclusionPath` for the workspace + electron-builder cache dirs before the package step, leaving Defender otherwise intact (signtool's scan of the signed `cockroach.exe` / `SkyTwin.exe` outputs is unaffected — only the build's intermediate .7z is excluded).

- **Embedded apps now ship as one `apps.tar.gz` instead of ~10,000 loose `pnpm-deploy` files.** Before this change, `extraResources` shipped each of `embedded/api/`, `embedded/worker/`, and `embedded/web/` as a hoisted node_modules tree — thousands of small files. On macOS / Linux this is fine; on Windows NTFS, electron-builder's win-unpacked copy step ran for an hour just to write them all. `apps/desktop/scripts/build-single-binary.sh` now packs the three trees into `dist/embedded/apps.tar.gz` after `pnpm deploy` (using `-h` to dereference symlinks so the archive is portable across hosts that require admin to materialize unix symlinks — Windows in particular). `apps/desktop/package.json` `extraResources` filter shrinks to `apps.tar.gz` + `bundle-manifest.json` only. `apps/desktop/src/service-manager.ts` gains `ensureEmbeddedRoot()` which extracts the tarball to `<userData>/embedded/` on first launch (or after a version bump, detected via a `.version` marker file), then caches the path for the lifetime of the process. `startApi()`, `startWeb()`, `startWorker()`, and `runMigrations()` all consume the extracted path. Expected CI time savings: 60-90 minutes on the Windows package step; user-facing first-launch latency: 5-15 seconds for the one-time tar extract. Subsequent launches are unchanged (existence check on the api/dist/index.js sentinel is a microsecond).

- **`nsis.differentialPackage` set to `false` + `compression: "normal"` pinned explicitly.** `differentialPackage: true` (electron-builder default) generates a `.blockmap` file for `electron-updater` delta downloads — useful when shipping incremental updates over a CDN, useless until §1.5 (release tag + auto-update channel) ships. Disabling it skips a slow post-NSIS step. `compression` defaults to `"normal"` already; pinning it makes the choice explicit so a future electron-builder version that silently bumps to `"maximum"` (LZMA-max, much slower) doesn't regress build time without anyone noticing.

- **CRDB binaries cached in CI + downloads parallelized.** `.github/workflows/build.yml`'s three desktop jobs now include `~/.cache/skytwin/crdb-binaries` in their `actions/cache@v4` `path` list — the five-platform CRDB binary set (~700MB) had been re-downloaded on every desktop build because the cache only covered electron / electron-builder dirs. The cache key now also hashes `apps/desktop/scripts/build-single-binary.sh` so a `SKYTWIN_CRDB_VERSION` bump invalidates correctly. Inside the script, the `for entry in CRDB_TARGETS; bundle_crdb_binary "$entry"; done` sequential loop is replaced with backgrounded calls + `wait $pid` reap, so even on a cold cache the five downloads happen in parallel (~5-10s end-to-end vs ~25-50s sequential). Each `bundle_crdb_binary` call uses local-scoped variables, a per-platform dest dir, and a URL-specific cache file, so racing them is safe. Failed background jobs surface via an explicit `crdb_failed` flag — `set -e` alone doesn't trip on backgrounded function failures.

## [0.6.57.0] - 2026-05-22

### Fixed

- **`packages/db` was ignoring `DATABASE_URL`.** The connection pool used separate `DATABASE_HOST`/`DATABASE_PORT`/`DATABASE_NAME` env vars and silently defaulted to `localhost:26257/skytwin`. The new desktop bundle picks a non-default CRDB port (`SKYTWIN_DB_PORT`) and ships a `DATABASE_URL` to the spawned API — but every migration and every query was actually landing on whatever stray `docker compose` CRDB happened to be on the default port. The bundled CRDB stayed empty; every downstream query 500'd on "relation does not exist"; OAuth callbacks died on "column account_email does not exist." `getPool()` now parses `DATABASE_URL` first and uses its host/port/db/user/password as the source of truth, with the legacy env vars as fallback. Re-evaluates on first call so service-manager's in-process env injection (Electron main runs migrations directly) takes effect.
- **Migration 023 (`decisions_user_signal_unique_idx`) failed on installs with historical duplicates AND referenced a future-migration column.** Split into two: 023 now only adds the `signal_id` column + backfill (always safe); a new 057 runs after the full schema is in place, dedupes the FK chain in dependency order (execution_events → execution_results → decision_outcomes.execution_plan_id NULL → execution_plans → feedback_events → explanation_records → approval_requests → decision_outcomes → candidate_actions → decisions), then creates the partial unique index. Idempotent on installs that never had dupes.
- **Migration 046 used `crdb_internal.force_error()` which the v23.2 bundled CRDB locks behind `allow_unsafe_internals = true`.** Replaced with a portable `SELECT 1/0 WHERE NOT EXISTS (...)` — same loud-fail semantics (SQLSTATE 22012 is outside the runner's idempotency carve-out) without needing CRDB's debug surface enabled.
- **Electron desktop now runs migrations in-process via the named `up()` export.** Earlier attempts to spawn a child node process for the migration script failed in three distinct ways: pnpm-deploy symlinks broke the `import.meta.url === pathToFileURL(argv[1]).href` CLI guard in 001-initial.ts; an `.mjs` shim bundled into `app.asar` wasn't readable from a child process (asar is an Electron-runtime overlay, not a real fs); an `--input-type=module -e <inline>` shim exited 0 silently. Electron's main process is node, has full asar awareness, resolves pnpm symlinks, and shares process.env — calling `up()` directly avoids every spawn quirk. Bypasses the CLI guard via `new Function('p', 'return import(p)')` (the TS compiler emits `require()` for `await import()` in CJS modules, which would refuse to load ESM targets).
- **Desktop bundle now uses `pnpm deploy` for self-contained app dirs.** The previous `cp -R apps/api/node_modules` ran on pnpm-symlinked trees; electron-builder later tripped on dangling links into `.pnpm/`. A naive `cp -RL` blew the bundle up to ~14 GB because pnpm's content-addressable store dedupes heavily. `pnpm deploy --prod` produces a flat hoisted bundle (~45 MB per app) with a single self-referencing back-symlink that we strip post-deploy.
- **Desktop bundle includes the web Express server, not just static assets.** `ServiceManager.startWeb()` now forks `apps/web` alongside API and worker. Previously the dashboard URL (`localhost:3200`) returned ECONNREFUSED on every packaged launch.
- **Per-installation `SESSION_SECRET` auto-generated in Electron main.** Persisted at `<userData>/secrets/session-secret` with mode 0o600 so cookies signed with it survive across launches. The API's production-mode validator used to refuse to start without it.
- **`USE_MOCK_IRONCLAW` defaults to true in the desktop bundle.** The previous `false` default required users to provide `IRONCLAW_WEBHOOK_SECRET` just to launch — pointless in an installed-app context where no IronClaw deployment exists.
- **vitest no longer recurses into `apps/desktop/dist-electron/`.** `pnpm deploy` ships `src/` inside the .app, and vitest's default discovery would pick up every test file there (without their workspace mocks) and fail the whole suite.
- **`apps/desktop/dist-electron/` is `.gitignore`d.** Was ending up in `git status --short` after every package run.
- **`packages/db/package.json`'s `build` script copies `src/migrations/*.sql` and `src/schemas/*.sql` to `dist/`.** Without this, the bundled migrations had `.js` runners but zero SQL — every fresh install applied 0 statements per file and reported success.

### Added

- **Google OAuth PKCE flow for installed clients (`@skytwin/connectors`).** New `generatePkcePair()` (RFC 7636 §4, 32-byte URL-safe verifier + S256 challenge); `generateAuthUrl()` attaches `code_challenge`/`code_challenge_method=S256` when a challenge is supplied; `exchangeCode()` sends `code_verifier` (no `client_secret`) for public clients and `client_secret` (no verifier) for confidential clients; `refreshAccessToken()` omits `client_secret` from the refresh request when the client is PKCE-only. 11 new tests in `google-oauth-pkce.test.ts`.
- **`apps/api/src/routes/oauth.ts` honors a `SKYTWIN_DEFAULT_GOOGLE_CLIENT_ID` baked into the desktop bundle.** When neither DB-stored nor env-var credentials exist, falls through to the bundled default and runs in PKCE mode — end users never see the "create your own Google Cloud OAuth app and paste your client_id+secret" friction. Server-local PKCE verifier store (`Map<state, codeVerifier>`) keeps the verifier off the Google round-trip; consume-on-read so a replayed callback can't redeem the same code twice.
- **`apps/desktop/src/service-manager.ts` injects the bundled Google client_id** into spawned API processes via env, with `process.env['SKYTWIN_DEFAULT_GOOGLE_CLIENT_ID']` overriding the build-time constant. The constant is now populated with the real `client_id` from the "SkyTwin Desktop" OAuth client (type: Desktop app) registered in the `skytwin-492700` Google Cloud project on 2026-05-22 — end users skip the "create your own Google Cloud OAuth app" step entirely. The OAuth consent screen is in "Testing" mode pending Google verification for the sensitive Gmail/Calendar scopes (a separate multi-week submission); listed test users sign in cleanly, other users will see the "unverified app" warning until verification completes.

- **Tiered OAuth scope policy + in-app Gmail-setup wizard.** Gmail's `readonly` and `modify` are Google-classified **restricted** scopes that require an annual ~$15k–$50k third-party CASA security assessment when accessed through a public OAuth client. To avoid blocking launch on that gate, `resolveRequestedScopes()` in `apps/api/src/routes/oauth.ts` splits the scope set by config source: the bundled SkyTwin-team client only ever requests `openid`, `email`, `profile`, `calendar.readonly`, and `calendar.events` (sensitive, no third-party fee — clears on standard Google app review in days–weeks). The full SkyTwin Gmail experience (content-aware triage, draft replies, body summarisation — the entire inbox half of the product) runs through user-supplied OAuth credentials, NOT as a fallback but as the launch Gmail path. A new in-app wizard at `apps/web/public/js/pages/connect-gmail.js` (route `/#/connect-gmail`) walks every user through the 5-minute Google Cloud Console setup: create project → enable Gmail API → configure consent screen → create OAuth client → paste credentials. The final step PUTs the creds via `/api/credentials/google` and immediately redirects through `/api/oauth/google/authorize?include=gmail&userId=…` so the consent dance happens against the user's just-saved client. Documented end-to-end at `docs/google-verification.md`, with the public web mirror at `docs/connect-gmail.html`. Restricted-scope verification for the bundled client (which would remove the wizard entirely) is tracked in [#351](https://github.com/jayzalowitz/skytwin/issues/351) — slated for when SkyTwin can sustain the annual CASA fee. Six new tests in `apps/api/src/__tests__/oauth-scope-tiers.test.ts` lock in the gating behaviour. The `/google/authorize` endpoint returns HTTP 412 with code `GMAIL_REQUIRES_BYO_CLIENT` and `help: '#/connect-gmail'` (in-app wizard) + `docs: 'https://jayzalowitz.github.io/skytwin/connect-gmail.html'` (external mirror) when a caller asks for `?include=gmail` under the bundled client.

- **GitHub Pages homepage + privacy policy + ToS + Connect-Gmail walkthrough** (`docs/index.html`, `docs/privacy.html`, `docs/terms.html`, `docs/connect-gmail.html`, `docs/_config.yml`) hosted at `https://jayzalowitz.github.io/skytwin/` once PR merges to main. Required for Google brand verification; the github.io subdomain is auto-verified so no Search Console DNS dance.

### Why this matters

The pre-v0.6.57 desktop .dmg launched, opened the dashboard, then 500'd on the first Gmail sync because none of its 57 migrations had actually applied — they were all hitting the wrong CRDB. And even with a working DB, a non-technical user still hit a "create your own Google Cloud OAuth app" wall before they could sign in. v0.6.57 closes both: migrations land where they're supposed to, and the OAuth handshake works with just a single bundled (public) client_id.

### Backward compatibility

- Operator-supplied `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` env vars (and DB-stored credentials from the Setup page) still take precedence over the bundled default — existing self-hosted deployments are unchanged.
- `DATABASE_URL` is now authoritative; the legacy `DATABASE_HOST`/`PORT`/`NAME` vars still work as fallbacks for deployments that set them.
- Migration 023 split into 023 (column add) + 057 (dedupe + index). Installs that previously ran 023 successfully (the original index lives) get a no-op from 057's `CREATE UNIQUE INDEX IF NOT EXISTS`.

### Tests

- 11 new tests in `packages/connectors/src/__tests__/google-oauth-pkce.test.ts` covering PKCE pair generation, S256 challenge derivation, authorization URL parameter shape, token-exchange request body in both modes, and refresh-token request body in both modes.
- All existing tests still pass (3,084 total across 20+ packages).

## [0.6.56.0] - 2026-05-21

### Changed

- **CockroachDB now ships as a hash-verified native binary; Docker is no longer required.** The one-command installer (`curl … | bash`) used to install Docker Desktop just to run CockroachDB in a container — by far the heaviest dependency on the list, with its own EULA and a "open it once after install" gotcha. The default path now fetches the official CRDB release archive (sha256-verified against the published `.sha256sum` sidecar), unpacks it into `~/.local/share/skytwin/bin/cockroach`, and spawns it as a child process. `bin/skytwin-db {install,start,stop,status,ensure-db,reset}` is the new control surface. Docker remains supported as an opt-in via `SKYTWIN_USE_DOCKER=true` for CI and users who already have a Docker workflow.
- **`bin/skytwin-dev` self-loads nvm.** Until now, `nohup ./bin/skytwin-dev` from `install.sh` (a non-interactive subshell) couldn't find `node` after a fresh nvm install because `.bashrc` doesn't fire in that context. Now the script sources `~/.nvm/nvm.sh` if `node` isn't on PATH. Same change for `corepack enable` + pnpm activation. Without this, the first-time install completed everything except actually starting the dashboard.
- **Both `bin/skytwin-install` and `bin/skytwin-dev` pass `--concurrency=1` to `pnpm build`.** Sidesteps the known turbo race on `@skytwin/db`'s dist/.d.ts that CLAUDE.md already documents — fresh installs hit it every time. ~10s slower; deterministic.

### Added

- **Electron desktop app bundles CockroachDB.** `apps/desktop/scripts/build-single-binary.sh` downloads the per-platform CRDB release (darwin-arm64, darwin-amd64, linux-amd64, linux-arm64, windows-amd64) into `dist/embedded/cockroach/<platform-arch>/`, hash-verified. electron-builder's `extraResources` ships them. New `apps/desktop/src/cockroach-manager.ts` resolves the right binary per `process.platform`/`process.arch` at runtime, spawns single-node CRDB against `app.getPath('userData')/crdb-data`, waits for SQL readiness, ensures the `skytwin` database. `ServiceManager` starts it before API/worker; `first-launch.ts` no longer demands an external `cockroach` on PATH.
- **Embedded llama.cpp is the default LLM fallback.** `apps/api/src/lib/llm-client-factory.ts` adds an `embedded` provider entry to the chain when BOTH the `llama-cli` binary AND a GGUF model are discoverable. Most dev machines have llama-cli on PATH via Homebrew but no model; the gate refuses to add a provider that would only throw `NotAvailableError`. Opt out via `SKYTWIN_DISABLE_EMBEDDED=1`.
- **Docker-based install validation harness.** `bin/validate-installs [ubuntu|debian|fedora]` builds a snapshot tarball of the working tree (excluding `node_modules`, `dist`, `.turbo`, `*.tsbuildinfo`), mounts it into a fresh Ubuntu 22.04 / Debian 12 / Fedora 40 container, drives `install.sh` end-to-end, and asserts `localhost:3200` responds. Catches fresh-install regressions before they reach users.
- **GitHub Actions workflow** (`.github/workflows/install-validation.yml`) runs the three-distro validation matrix on every PR that touches the install pipeline.

### Fixed

- **Migration 055 used `do` as a table alias, which is a CockroachDB v23.2+ reserved keyword.** Every fresh-install migration run failed at this statement with `error: at or near "do": syntax error`. Renamed to `outcomes`. Idempotent re-runs are a no-op because of `IF NOT EXISTS` on the column plus the `WHERE execution_plan_id IS NULL` backfill guard. Caught by the new validation harness — existing dev environments masked it because their Docker volumes already had the column.
- **`bin/skytwin-db` detects orphaned listeners via the SQL port even when its own PID file is missing.** Without this, a script crash between `start` and PID-file-write left an unrecoverable `cockroach` process holding port 26257 that subsequent `start`s couldn't kick off and couldn't stop without manual `lsof | xargs kill`.
- **Embedded provider gate also checks for an installed model**, not just the binary. Previous version added the provider whenever `which llama-cli` succeeded — which broke every `getLlmClientFromConfigFresh` test on dev machines that have llama-cli via Homebrew but no SkyTwin model.
- **Snapshot tarball excludes `*.tsbuildinfo`.** Without this, tsc inside the validation container saw the host's incremental cache, decided "the build is up-to-date," and emitted `.js` + `.d.ts.map` but NOT `.d.ts` — silently breaking every downstream package that imports those types. Pure validation-harness bug, not a code bug, but it was masking a real install regression.

### Why this matters

The pre-v0.6.56 install needed Docker Desktop (~700MB, EULA, daemon-running gotcha) and Ollama + a 9.6GB gemma model just to run the default flow. A non-technical user couldn't get past that. The new default has two prerequisites — Node 20+ and pnpm — both installed automatically by `bin/skytwin-install`. The native CRDB binary is ~140MB, ships its own data dir, and survives reboots without any "open Docker once" step. The embedded LLM provider runs entirely on-device when present and silently no-ops when not.

### Backward compatibility

- `SKYTWIN_USE_DOCKER=true ./install.sh` reproduces the old Docker-based path. `bin/skytwin-dev --use-docker` does the same at runtime.
- `SKYTWIN_WITH_OLLAMA=true ./install.sh` installs Ollama + pulls gemma4 for users who want the legacy LLM provider.
- All existing env vars (`DATABASE_URL`, `ANTHROPIC_API_KEY`, etc.) still take precedence over the bundled defaults. Power users who hosted their own CRDB by setting `DATABASE_URL` keep working untouched.

### Tests

- 10 new tests in `apps/api/src/__tests__/llm-client-factory.test.ts` covering the embedded-runtime gate (binary-only, model-only, both, kill-switch, hosted-key combinations).
- 6 new tests in `apps/desktop/src/__tests__/cockroach-manager.test.ts` covering path resolution, port overrides, connection string, data dir, and the 127.0.0.1-default bind.
- Docker validation harness as a regression test for the install pipeline itself — replaces the manual "rebuild the world and see if it works" step that used to gate every release.

### Fixed (post-/review)

Findings from the in-PR `/review` pass and Copilot inline review on the
initial commit (cf5eec5). Each landed as its own commit so the
"what was the first cut, what did review catch" diff stays legible.

- **Single-instance lock in Electron main (commit 9f81009).** Double-clicking the dock icon while the app was already running would race two `CockroachManager.start()` calls against the same data dir; loser hit CRDB's LOCK file with no UI feedback. Now `app.requestSingleInstanceLock()` rejects the second launch and surfaces the existing window.
- **CRDB binds 127.0.0.1, not 'localhost' (commit 9f81009).** Avoids the IPv6-unspecified gotcha on systems whose `/etc/hosts` maps `localhost` to `::` — broadcasting the `--insecure` cluster to the LAN would have been remote root.
- **Graceful drain via `cockroach node drain` + 30s SIGTERM timeout (commit 9f81009).** Previous 5s SIGKILL would have corrupted WAL mid-flush on every quit.
- **`bin/skytwin-db` tmpdir cleanup via EXIT trap (commit 9f81009).** Every failed download / sha-mismatch / extract-failure used to leak ~70MB into `/tmp`.
- **electron-builder extraResources per-platform filtering (commit 9f81009).** Old config shipped all five platforms' CRDB binaries (~700MB) inside every artifact. Each platform's installer now carries only its own binary.
- **`bin/skytwin-db` honors `XDG_DATA_HOME` (commit 9f81009).** Falls back to `~/.local/share/skytwin` per spec when unset.
- **`SKYTWIN_DB_BINARY_URL_BASE` allowlist (commit 9f81009).** Belt-and-suspenders against `file://` / `ftp://` / internal-SSRF overrides; SHA-256 verify is still the real defense.
- **Per-service logs to `$ROOT/.logs/` instead of `/tmp/` (commit 9f81009).** systemd `PrivateTmp=yes` and `tmpfiles.d` cleanup were wiping the exact logs needed to debug a failed install attempt.
- **`find -perm` BSD/macOS portability (commit 9f81009).** Old `-perm -u+x` was GNU-only; the BSD find on macOS silently emitted nothing and the install fell through to "Could not locate cockroach binary."
- **CRDB `--log-dir` pinned to `userData/crdb-logs` (commit 9d87164 — Copilot).** The `waitForReady()` timeout error message said "Check logs in `<dataDir>/logs`" but CRDB was using its default location.
- **`isReady()` → `isCrdbResponding()` real SQL probe + always ensure-db on the early-return path (commit e3c3951 — Copilot).** The old TCP-listener check would have accepted any process on port 26257, including non-CRDB tools; a partial first run that left CRDB running without `CREATE DATABASE` would have made the next launch silently start the API against a missing database. The new check runs `cockroach sql -e 'SELECT 1'`, and `start()` always calls `ensureDatabase()`.
- **Docs sync — CONTRIBUTING.md + docs/cockroach-architecture.md + docs/technical-spec.md (commit bb25f9b).** Three docs still told contributors to run `docker-compose up -d cockroachdb`; all now lead with `bin/skytwin-db install && start && ensure-db` and treat Docker as a labeled opt-in subsection.

## [0.6.55.0] - 2026-05-18

### Changed

- **CI build speed: turbo remote cache + path-filtered desktop/mobile jobs + native-toolchain caches.** Three changes to `.github/workflows/{build,evals,release}.yml`:
  1. **Turbo remote cache via the GitHub Actions cache** (`dtinth/setup-github-actions-caching-for-turbo@v1`) on every job that runs `pnpm build`. The first job populates the cache; the 5+ subsequent jobs (desktop-mac/win/linux, mobile-android/ios, evals, release matrix) get `pnpm build` as cache hits across the entire monorepo. No Vercel account required — it routes turbo's HTTP cache protocol at the free Actions cache backend. Skipped on Windows desktop runners (action writes to `/tmp` which doesn't exist on Windows); macOS + Linux still benefit.
  2. **Path-filtered desktop + mobile jobs on PRs.** New `changes` job uses `dorny/paths-filter@v3` to detect whether `apps/desktop/**`, `apps/mobile/**`, `packages/**`, or lockfiles changed. PRs that don't touch those paths skip the entire desktop/mobile matrix (5 jobs × ~native-toolchain-bootstrap minutes). Push events to `main` and tag pushes always run everything, so release artifact coverage is unchanged.
  3. **Native toolchain caches:** electron-builder downloads (per-OS paths), Gradle (via `gradle/actions/setup-gradle@v4`), and CocoaPods (`Pods/`, `~/Library/Caches/CocoaPods`). These were re-downloaded on every run before — hundreds of MB per OS, per job.
- Effect: cold-cache wall-clock unchanged. Warm-cache `pnpm build` drops from ~minutes to seconds on every job after the first. PRs that don't touch desktop/mobile skip ~5 jobs entirely. CI cost is $0 (public repo) but wall-clock is what we were burning.

### Why this matters

We're an open-source repo so Actions minutes are free, but wall-clock matters for iteration speed. Before this change, every PR rebuilt the entire TypeScript monorepo 6× (once per build/package job) and re-downloaded the electron toolchain on each desktop runner. The turbo remote cache turns 5 of those 6 `pnpm build`s into cache restores. The path filter skips the 5 desktop+mobile jobs entirely for PRs that don't touch those apps (most PRs).

### Note on version

Bumped to 0.6.55.0 (was 0.6.54.0 on the branch) after rebase — #335's per-Lifebook briefing sections took the 0.6.54.0 slot on main first.

## [0.6.54.0] - 2026-05-18

### Added

- **Per-Lifebook briefing sections folded into `/api/twin-briefings/latest` (closes #320, decomposed from #193).** Response shape grew an additive `sections: Array<{ lifebookId, domainName, importance, briefing }>` field alongside the existing `briefing` field. Sections are one row per visible Lifebook that has a per-domain briefing, ordered by Lifebook importance (core → secondary → emerging, then last_seen_at DESC). Lifebooks without a matching per-domain briefing are omitted (no empty-section slots). Backend partitioning shipped earlier in #258; this PR is the API fold + web rendering.
- **New repository method `briefingRepository.getLatestPerLifebook(userId, cadence?)`.** Single `DISTINCT ON (domain_name)` query — one round-trip regardless of Lifebook count. Equivalent to N+1 `getLatestForUserDomain` calls but bounded. Hard-filters `domain_name IS NOT NULL` so it can never accidentally fold a global briefing into the sections list (which would double-render the same row on the dashboard).
- **Web rendering in `twin-briefing.js`.** Per-Lifebook sections render as collapsible `<details>` elements between the global prose section and the history sidebar. First card (typically the top-importance Lifebook) is open by default; rest collapse to avoid a wall of text on load. Each card surfaces the domain name + importance badge + age. Skipped entirely when `sections[]` is empty (new user, no per-Lifebook briefings yet).

### Why this matters

The backend partitioning landed in #258 — the worker emits per-Lifebook briefings as separate `twin_briefings` rows with `domain_name` set. But until now the dashboard only fetched the global briefing; the per-Lifebook rows were only reachable via the per-Lifebook detail page. Folding them into `/latest` gives the dashboard a single round-trip to render the full partitioned view, and the collapsible UI keeps the global briefing as the focal point with per-domain detail one click away.

### Backward compatibility

- Response shape is additive — the existing `briefing` field still appears with the same shape; existing consumers that read `data.briefing` continue to work unchanged.
- `sections` is always an array (never undefined) — empty for users with no per-Lifebook briefings; no need for `Array.isArray` guards on the consumer side, though `twin-briefing.js` defensively checks anyway.
- The `/lifebook/:domain/latest` endpoint is unchanged — still returns just `{ briefing }` for callers that need a single domain in isolation.

### What's deferred (none — issue is fully closed)

Mobile rendering is in the same pattern but lives under `#179` (mobile parity) since the mobile briefing surface is a different code path. The browser-side fold here is the canonical reference for the mobile port when it lands.

### Tests

- 5 new repository tests in `briefing-repository-per-lifebook.test.ts` pinning: DISTINCT ON + cadence threading + global-briefing exclusion + empty-result case.
- 6 new route tests in `twin-briefings-sections-fold.test.ts` pinning: 400 on missing userId; empty-state shape; global-only path; importance-ordered sections with omit-when-no-briefing; hidden Lifebooks excluded (via listVisible contract); cadence query param threads to both queries.

## [0.6.53.0] - 2026-05-18

### Added

- **`lifebook-layout` prompt + adaptive detail-page renderer (#319, partial).** New prompt at `packages/policy-prompts/prompts/lifebook-layout/v1.md` with schema + 3 eval fixtures (health-shaped, project-shaped, sparse-fallback). The prompt picks a section ordering from 8 section types — `timeline`, `signals`, `capabilities`, `entities`, `decisions`, `metrics`, `schedule`, `inline_edit` — tuned to the actual signal-type distribution in a Lifebook's wing, not just the domain name. Health-heavy wings get timeline-first; project-heavy wings get decisions-first; sparse wings always get the generic two-column layout (a constraint clause in the prompt; the route bypasses the LLM entirely when fewer than 5 drawers / 3 distinct types).
- **New endpoint `GET /api/lifebooks/:userId/:domainName/layout`.** Computes the histogram from `mempalaceRepository.getDrawers(userId, { wingId, limit: 200 })`, runs the prompt with `{ lifebook, signal_histogram }`, returns `{ layout, source, histogram }`. `source` is one of `'llm'`, `'no_signals'`, `'sparse_fallback'`, `'no_llm_configured'`, `'provider_lookup_failed'`, `'deterministic_fallback'`, or `'prompt_error'` — surfaced to the UI so users get an explainable "why am I seeing a generic layout" line. (The browser also synthesizes `'fetch_error'` locally when the HTTP request itself fails; that value is never sent by the endpoint.)
- **Adaptive `lifebook.js` renderer.** Detail page fetches lifebook + briefing + layout in parallel via `Promise.allSettled`; renders the fixed header + per-Lifebook briefing card first (identity, not data), then iterates the layout's `sections` in `order` and dispatches to per-type renderers. Sections without backend data yet (`entities`, `decisions`, `metrics`, `schedule`, `inline_edit`) render explicit "what this is + how to wire it" placeholder cards rather than empty divs — so prompt-asked-for sections are visible to the next developer instead of silently dropped. Unknown section types render a "Frontend needs an update" card (forward-compatible).
- **Token-spend protection.** The route skips the LLM entirely (no `runPrompt` call) when the wing has 0 drawers, or when the histogram is < 5 drawers / < 3 distinct types. The prompt's own constraint clause says to return the generic layout in those cases; not invoking it saves the token spend AND keeps latency under ~50ms for sparse Lifebooks.

### Why this matters

Before #319 every Lifebook detail page used a single hardcoded template — Sample signals + Suggested capabilities cards in a fixed order. That works for "any" domain but doesn't lean into what the domain actually contains. A user with a Health Lifebook full of appointments + lab results gets the same shape as a user with a Kayaking Lifebook full of gear receipts. With the adaptive layout, the prompt picks the section ordering from the actual signal histogram in the wing — without any new data backends required for v1 (each section renderer degrades gracefully when its data isn't wired yet).

### What's deferred (issue #319 stays open)

- **Backend data for the speculative section types** — `entities`, `decisions`, `metrics`, `schedule`, `inline_edit` currently render explanatory placeholder cards. Each is its own slice (entity router, per-Lifebook decision filtering, metrics rollup, calendar filter, fact-edit recorder).
- **Inline edit on extracted facts** — the original #319 AC mentioned inline edit with provenance recording; the layout prompt is forward-compatible (the `inline_edit` section type exists in the schema) but the recorder hasn't shipped.

### Tests

- 7 new route tests in `lifebook-layout-route.test.ts` pinning: 404 on missing lifebook; no_signals path skips LLM; sparse_fallback path skips LLM (token-spend protection); no_llm_configured fallback; LLM happy path returns the prompt's layout + histogram; deterministic-fallback path; fail-soft on `runPrompt` throw. Plus 2 added in post-Copilot fixes: `provider_lookup_failed` source on `getEnabledForUser` throw; centralised `GENERIC_LAYOUT` shape.

### Note on version

Bumped to 0.6.53.0 (was 0.6.52.0 on the branch) after rebase — #334's gbrain floor-ratio sync took the 0.6.52.0 slot on main first.

## [0.6.52.0] - 2026-05-18

### Changed

- **Floor-ratio gate sync with gbrain v0.35.6.0 / PR #1129.** Our contribution to upstream gbrain (PR #1091) was closed in favor of a reworked shape that landed yesterday as #1129. The merged version kept the empirical motivation, the dense-embedder targeting, and the `0.85` starting value from our SkyTwin labeled-retrieval ablation, but the codex outside-voice review caught three defensive gaps in our original shape. This PR ports those fixes into our additive tier-weight implementation in `packages/memory-gbrain-crdb-adapter/src/rrf.ts` and aligns the option naming with upstream `SearchOpts.floorRatio` / `search.floor_ratio`.

### What got hardened

- **No-positive-signal inputs now disable the gate, not silently reject everything.** Our prior `topRawScore = 0` init meant if every entry's `rrfScore` was negative (rare but possible — already-bonused results re-folded, or scoring path that emits negatives), `threshold = 0` and every entry failed `r.score < 0`. Top itself would be gated out. New behavior: `computeFloorThreshold` returns `Number.NEGATIVE_INFINITY` for all-negative, all-NaN, or empty inputs — the gate disables, matching upstream `computeFloorThreshold` semantics.
- **Out-of-range `floorRatio` values silently disable the gate.** NaN, Infinity, negative, or `> 1` now return `-Infinity` from the threshold helper. Defense in depth so a malformed config value never gates anything. The `floorRatio: 0` case stays legitimate (zero is a valid in-range value meaning "no real gate").
- **NaN-score skip in the bonus loop + sort-safety drop.** `NaN < threshold` is `false` in JS, so a NaN-scored hit would slip past `hit.rrfScore < threshold` and then have a bonus added on top — poisoning the sort. Now an explicit `Number.isFinite(hit.rrfScore)` check skips the bonus stage for non-finite scores, AND the post-loop filter drops non-finite-scored entries from results entirely. The sort comparator `b.rrfScore - a.rrfScore` returns `NaN` for any NaN side, which JS sort treats as 0 (equal) — leaving NaN-scored hits in insertion order, where they can survive the `slice(0, k)` and corrupt top-k results. Same applies to `+Infinity` (sorts to the top of every query). Dropping them is the only safe move once non-finite scores can be reached (e.g. caller-supplied `rrfK: NaN`). Caught by codex outside-voice during PR #334 review (T3).

### Codex review fixes (post-review)

- **Invalid `floorRatio` no longer silently bypasses a valid legacy guard (codex T2).** Prior precedence `options.floorRatio ?? options.tierWeightFloorRatio ?? DEFAULT_FLOOR_RATIO` meant `floorRatio: NaN` (e.g. from a buggy config parse) won the chain and disabled the gate, even if the caller had `tierWeightFloorRatio: 0.85` working. New behavior: `pickValidFloorRatio` walks the candidates and uses the first finite value in [0, 1]; invalid values fall through to the alias, then to `DEFAULT_FLOOR_RATIO`. A partially migrated caller piping a malformed new option keeps the legacy guard.
- **Sort safety via post-loop `isFinite` filter (codex T3).** Documented in the bullet above. Two new tests pin the failure mode: `rrfK: NaN` corrupts every contribution to NaN → all hits dropped, output is `[]` (instead of NaN-scored hits sorted into top-k by insertion order).

### Option naming

- `RrfFoldOptions.tierWeightFloorRatio` → `RrfFoldOptions.floorRatio` for naming parity with upstream `SearchOpts.floorRatio`. `tierWeightFloorRatio` is preserved as a deprecated alias; `floorRatio` wins when both are set. No call sites in this repo set it today, so the deprecated path exists purely to insulate any external consumer of `@skytwin/memory-gbrain-crdb-adapter`.
- New exports from `@skytwin/memory-gbrain-crdb-adapter`: `computeFloorThreshold(entries, floorRatio)` and `DEFAULT_FLOOR_RATIO` (`0.85`). The helper mirrors gbrain's `computeFloorThreshold` shape so future cross-port refactors can use one mental model.

### What's NOT in scope

- **CLI shellout `--floor-ratio` pass-through.** `GbrainMemoryPort` still doesn't surface a per-call flag. Users who run an external gbrain CLI can `gbrain config set search.floor_ratio 0.85` globally; adding a per-call plumb requires deciding what option the `MemoryPort` contract should carry, and that's a separate API decision.
- **Surfacing `floorRatio` on `SearchSemanticOptions`.** The default 0.85 stays the only knob most callers should ever need. Exposing it on the read API would invite tuning churn without an ablation surface to validate against. Deferred until a real consumer needs it.
- **`MODE_BUNDLES.floor_ratio`** equivalent for SkyTwin. We don't have search modes; the gate is always on by default in the additive tier-weight path. The upstream mode bundles are an orthogonal concept.

### Tests

- 22 new test cases in `packages/memory-gbrain-crdb-adapter/src/__tests__/rrf.test.ts`: `computeFloorThreshold` defensive guards (undefined / out-of-range / NaN / Infinity / empty / negative-top / all-NaN / mixed / valid+positive / default constant), floorRatio precedence over deprecated `tierWeightFloorRatio`, back-compat alias still respected, fail-safe fallback when `floorRatio` is invalid but the alias is valid, fall-through to `DEFAULT_FLOOR_RATIO` when both are invalid, sort-safety drop for NaN-scored hits, and the strong-vs-tail RRF construction that actually exercises the gate (RRF flatness means rank-1 vs rank-2 don't differ enough — you need rank-20+ in a single list to push under 0.85 × top, a gap Copilot flagged on three of the post-/review tests).
- All 135 RRF tests pass (was 116). All 100 `@skytwin/memory-gbrain` tests pass — the realistic-retrieval ablation still reports `mean R@5 1.000 pure-RRF / 0.929 tier-on`, unchanged by the rename and the codex/Copilot review fixes.

### Upstream feature triage (filed for follow-up)

Surveyed recent gbrain releases for adoption candidates. Punch list:

- **#897 v0.33.2.0 search-lite (token budget + semantic query cache + intent weighting)** — pursue first. Token budget directly addresses Claude API token-limit pressure; ~2 days to port across embedded port + cache table behind a flag.
- **#1008 v0.35.0.0 zerank-2 reranker** — pursue second. Slots cleanly between RRF fold and tier-weight bonus; ~1.5 days. zembed-1 embeddings are a sidegrade at our scale — skip.
- **#996 v0.34.1.0 federated_read** — skip. One brain per user, inapplicable.
- **#1131 v0.35.7.0 temporal trajectory + founder scorecard** — defer. Entity-time-series shape, not what our personal signals carry today.

## [0.6.51.0] - 2026-05-18

### Added

- **Lifebook importance promote/demote ceremony (#321, partial — UI deferred).** Migration 056 adds `metadata JSONB NOT NULL DEFAULT '{}'` to `lifebooks`; the existing schema.sql declaration is updated in lock-step so fresh-DB bootstrap matches. The `metadata.importanceOverride` shape is `{ value, setAt, decayDays }` where `decayDays = 0` means "never auto-decay until cleared."
- **Override-respecting upsert in `lifebookRepository.upsert`.** The weekly domain-extraction worker calls this with the LLM's picked `importance`. When a row has a fresh override (within `decayDays` of `setAt`, or `decayDays = 0`), the SQL CASE keeps the override value instead of overwriting from the worker. Race-free: the freshness check happens in SQL so the worker doesn't need a fetch-then-write. Non-importance fields (`sample_signals`, `suggested_capabilities`, `wing_id`, `last_seen_at`) always update fresh — the override is gated only on `importance`.
- **Two new repo methods**: `setImportanceOverride(userId, domainName, value, decayDays = 90)` writes the override JSON AND sets the `importance` column immediately (so the next read reflects the override without waiting for the extractor to re-run); `clearImportanceOverride(userId, domainName)` strips the override key via the JSONB `-` operator. Both return the updated row or `null` (caller can 404).
- **Two new endpoints**: `POST /api/lifebooks/:userId/:domainName/importance` (body: `{ value, decayDays? }`) and `DELETE /api/lifebooks/:userId/:domainName/importance`. Both pass through `bindUserIdParamOwnership` middleware. Invalid `value` → 400; missing row → 404.
- **API response surface grows `importanceOverride`** field on every `LifebookJson` (`null` when no override exists). The UI uses this to render "set by you" vs "auto-detected" labels and offer a Clear button.

### Why this matters

Before #321 the domain-extraction worker unconditionally overwrote `importance` from the LLM's pick every weekly run. That ignored the user's taste — a user who said "Aging Parents is the most important thing in my life right now" would see that promotion silently reverted on the next worker pass. With the override, manual taste persists until the user explicitly clears it or until the decay window expires.

### What's deferred (issue #321 stays open)

- **UI surface** — promote/demote control on the dashboard card + per-Lifebook detail page, plus Settings → Lifebooks hidden-management. Backend is complete; UI is the next slice.
- **Episode recording** — the issue body called for the override to be recorded as an episode in mempalace so the twin remembers ("user promoted X on date Y"). Foundation is in place (the override has a `setAt` timestamp); wiring it into `mempalaceRepository.recordEpisode` lands with the UI slice.

### Tests

- 10 new unit tests in `lifebook-repository.test.ts` pinning: upsert SQL includes the override-respecting CASE; non-importance fields always update; setImportanceOverride writes the JSON + sets importance immediately; defaults to decayDays = 90; preserves 0 as the never-decay sentinel; returns null on missing row; clearImportanceOverride uses the JSONB minus operator; idempotent.
- 7 new route tests in `lifebook-importance-routes.test.ts` pinning: 400 on invalid/missing value; 200 happy path returns updated lifebook with `importanceOverride` surfaced; default + custom + zero decayDays pass-through; 404 on missing row; DELETE strips the override.

## [0.6.50.0] - 2026-05-18

### Added

- **`capability-install-suggestion` prompt + endpoint + browser wiring (closes #322).** New prompt at `packages/policy-prompts/prompts/capability-install-suggestion/v1.md` with schema + 3 eval fixtures (clear-install-intent, policy-refusal-not-capability-gap, already-have-tool). The prompt is the explicit MIRROR of `reverse-capability-intent`: that one picks from already-installed capabilities to route a known intent; this one picks from the UNINSTALLED registry to suggest what would unblock a refused user request. Two separate prompts is the right call — the existing `reverse-capability-intent` template, frontmatter, and all 3 of its fixtures explicitly assume "if no installed match, return empty" semantics, which is exactly the failure case `capability-install-suggestion` needs to invert.
- **New endpoint `POST /api/assistant/install-suggestion`.** Takes `{ userMessage, assistantReply }`; returns `{ intentDetected, suggestions: [{ registryId, displayName, reason, confidence }], reason? }`. Resolves the user's installed-capability set (excluded from suggestions) + the full registry (the allowed candidate set), runs the prompt, applies a belt-and-suspenders filter to drop any installed-capability suggestion that leaked through, and translates snake_case prompt output → camelCase boundary response. Falls back to `{ intentDetected: false, reason: 'no_llm_configured' }` when the user has no AI provider configured OR when the prompt invocation throws — the browser uses this signal to fall back to its keyword heuristic.
- **Browser wiring in `assistant.js`.** `checkReverseCapabilityFlow` now calls the LLM endpoint first. On `intentDetected: true` with confidence >= 0.5, renders the model's suggestions (each as a "Connect X" button with the prompt's `reason` as the tooltip). On `reason: 'no_llm_configured'` or fetch failure, falls back to the existing keyword + service-name-hint heuristic (`runHeuristicReverseCapability`) — demo flows still work without an provider. On `intentDetected: false` from the prompt (e.g. policy refusal, no clear capability gap), renders nothing and does NOT fall through to the heuristic, which would force a keyword match where the prompt explicitly said "none."
- **Test coverage:** 7 new tests in `assistant-install-suggestion.test.ts` pin: 400s on missing inputs; no_llm_configured shape when no providers; LLM happy path with snake_case→camelCase translation; belt-and-suspenders filter for installed-capability leakage; deterministic-fallback path; fail-soft on `runPrompt` throw.

### Why a new prompt instead of repurposing `reverse-capability-intent`

The existing prompt's template body says "Installed capabilities: {{installed_capabilities}}" with the system message "which installed capabilities can fulfill it" and the constraint "Return empty candidate_capabilities array if no installed capability matches." All 3 of its eval fixtures verify the "empty result when nothing installed matches" behavior. The `capability-install-suggestion` use case needs the OPPOSITE — when nothing installed matches, suggest something to install. Repurposing would force rewriting the template, the constraints, AND all 3 fixtures; that's a rewrite wearing the costume of a refactor. A sibling prompt with its own fixtures keeps each prompt's intent + invariants self-evident and lets the existing `reverse-capability-intent` consumer (the capability-engine's clarification flow) stay untouched.

### Backward compatibility

- Heuristic fallback path is unchanged in behavior — the legacy keyword scan + 9-entry service-name hint table still runs when no LLM is configured or the fetch fails. Demo flows without an LLM provider continue to work.
- TODO(#306) markers in `assistant.js` removed.

## [0.6.49.0] - 2026-05-18

### Added

- **Structural FK `decision_outcomes.execution_plan_id` (#324, partial).** Migration 055 adds the nullable column + partial index `WHERE execution_plan_id IS NOT NULL`, plus an idempotent backfill that joins `decision_outcomes ⋈ execution_plans` on `decision_id` (latest plan wins for the rare retry case, matching the existing `executionRepository.getByDecisionId` semantics). FK direction (`decision_outcomes → execution_plans`) chosen because outcomes are already 1:1 with decisions (UNIQUE constraint) and the approval path creates the outcome before the plan exists — NULL gracefully covers the approval-pending interval.
- **All three execution-plan write paths populate the FK.** `executionRepository.createPlan` now runs the INSERT + UPDATE in one CockroachDB transaction, and the two direct inserts in `apps/api/src/routes/approvals.ts` (success path L454 + failure path L497) do the same atomic update. **"Latest plan wins"** semantics — every new plan overwrites the outcome's `execution_plan_id` to point at itself. This matches both the migration 055 backfill (which picks the latest plan per decision) and `executionRepository.getByDecisionId`'s `ORDER BY created_at DESC LIMIT 1` read semantics, so a retry-after-rejection plan correctly becomes the outcome's current pointer. Historical plans for the same decision are still reachable via `SELECT * FROM execution_plans WHERE decision_id = ?` — the outcome FK is the "current plan" pointer, not an immutable first-write record.
- **Rollback stub upgraded to real plan-ID resolution (`POST /api/capabilities/:id/rollback-recent`).** Previously returned `{ result: 'rolled_back' }` as a literal stub even though no rollback ran. Now uses a subquery (not a LEFT JOIN — avoids duplicating provenance rows if `selected_action_id` ever isn't unique) to resolve the real `execution_plan_id` for each reversible action and returns it in the response shape `{ actionId, planId, result }`. `result` is `'pending_adapter_wiring'` when the FK lookup succeeds (actual `IronClawAdapter.rollback(planId)` call is the next step — needs routing through `executionRouter`) and `'no_plan_linkage'` when it doesn't (honest reporting beats lying about rollback success when we have no plan ID to target).

### Why this matters

The 4 stubbed sites in `capabilities.ts` and the duplicate stub in `apps/worker/src/jobs/promotion-eligibility-check.ts` were proxying through `capability_provenance_nodes` because the structural linkage didn't exist. Worse: provenance's `node_type='action'` rows aren't actually written anywhere in current code, so the queries returned empty result sets in real deployments. This PR adds the real linkage; future PRs can replace the stubbed queries with structural joins as they need to.

### Scope explicitly NOT in this PR (issue #324 stays open)

- **Wiring the actual `IronClawAdapter.rollback(planId)` call.** The rollback endpoint now reports plan IDs but doesn't dispatch the adapter call — that requires routing through `executionRouter` to pick the right adapter for each plan. Separate PR.
- **Promotion-stats stubs (capabilities.ts L1222 + L1235, worker L68-86).** These need a `server_id` column on `execution_plans` (or a join through `candidate_actions.parameters` JSON) to resolve "approvals per server." Different schema change; filed for follow-up.
- **Time-machine stub (capabilities.ts L464-540).** Returns "alternate decision pipeline not yet wired" — depends on a decision-pipeline rerun harness, not on this linkage.

### Backward compatibility

- Nullable column; existing rows backfilled from `execution_plans` joined on `decision_id`. Approval-pending and rejected-without-execution outcomes stay NULL — correct, no plan exists.
- `executionRepository.createPlan` now wraps in a transaction. Same external behavior on the happy path; differs only in failure semantics (both INSERT + UPDATE succeed together or both roll back — strictly safer than the old non-atomic version).
- Response shape of `POST /api/capabilities/:id/rollback-recent` changed: `undone[]` items now include `planId: string | null` and the `result` enum widened to include `'pending_adapter_wiring'`. No frontend consumers exist today (grep confirms zero callers in `apps/web/`, `apps/desktop/`, `apps/mobile/`).

### Tests

- 4 new unit tests in `execution-repository.test.ts` pinning: (1) createPlan links the matching outcome in the same transaction; (2) skips the UPDATE when no decisionId provided; (3) `WHERE execution_plan_id IS NULL` guard means retry plans cannot stomp the original outcome's link; (4) both statements share one transaction so failure rolls back consistently.

## [0.6.48.0] - 2026-05-18

### Added

- **`registry_id` foundation on `spend_records` + real per-app monthly totals (#323, partial).** Migration 054 adds a nullable `registry_id STRING` column plus a **partial** composite index `idx_spend_user_registry_time` on `(user_id, registry_id, recorded_at DESC) WHERE registry_id IS NOT NULL` (partial keeps the index small + write-cheap while today's writes still default to NULL — Copilot caught the original unconditional-index version as write-amplifying for zero query benefit). `spendRepository.create` and `checkAndRecordSpend` now accept an optional `registryId` and write it through; the policy-engine `SpendRepositoryPort.checkAndRecordSpend` interface grew the same optional field so port consumers can pass it through transparently. `getMonthlyTotal(userId, appRegistryId)` previously returned 0 unconditionally for per-app queries (safe-fallback stub from #306); it now executes the real `WHERE user_id = $1 AND registry_id = $2 AND recorded_at >= date_trunc('month', now())` query.

### Why this matters

The per-app monthly cap path (`SpendTracker.checkMonthlyLimit` → `SpendRepositoryPort.getMonthlyTotal(userId, appRegistryId)`) and the per-app summary path (`SpendTracker.getMonthlySpendForApp`, used by monthly-spend dashboards) have both been wired since #299 but couldn't ever fire — the repo always returned 0, so no per-app cap could be reached and per-app summaries always rendered as zero. With #323 the foundation is in place: any future spend-recording site that knows its registry source (e.g. an MCP-action spend pipeline) can pass `registryId` and both paths start attributing correctly. Existing call sites that don't pass `registryId` (cost-gate's draft-email LLM cost, today) write NULL and continue to roll into user-global totals only.

### What's deferred (issue #323 stays open until these land)

- **Decision pipeline population.** No call site passes `registryId` yet — cost-gate records LLM cost which has no MCP-server source. Wiring an MCP-action spend pipeline that knows its registry_id is the follow-up. Depends on #324 (decision↔execution linkage) to know which server an action ran against.
- **Backfill for pre-054 rows.** Old rows have no `decision_id → execution_plan → server_id` linkage yet; nothing to backfill from until #324 ships.

### Backward compatibility

- Nullable column; existing rows stay NULL. `getMonthlyTotal(userId)` (no second arg) behavior is unchanged — sums everything regardless of `registry_id`.
- Cost-gate continues to call `checkAndRecordSpend` without a `registryId`, so per-day cap behavior is unchanged.
- `getMonthlyTotal(userId, appRegistryId)` now returns a real number (was always 0). Both consumers — `SpendTracker.checkMonthlyLimit` and `SpendTracker.getMonthlySpendForApp` — change from the over-permissive 0-fallback to honest empty-results-until-rows-exist. Today no per-app rows exist, so both still observe 0 in practice; the difference only matters once a spend-recording site starts passing `registryId`.

### Tests

- 8 new unit tests in `spend-repository.test.ts` pinning: create writes `registry_id` when provided, writes NULL otherwise; `getMonthlyTotal` filters by `registry_id = $2` only when `appRegistryId !== undefined` (empty string is a real filter, not a missing one); `checkAndRecordSpend` writes the registry_id in the atomic insert; **NULL-registry rows roll into the user-global sum but never into per-app totals** (asserts the SQL has no OR/COALESCE that would widen NULL into per-app matches).

## [0.6.47.0] - 2026-05-18

### Added

- **"Latest Briefing" item in the desktop tray menu (closes #327, deferred from #191 AC#4).** The pure-data `buildTrayMenuItems` builder always advertised four actions including `latest-briefing`, but the actual Electron menu constructed in `createTray` was missing it — users could click into Open Dashboard, Pause/Resume, Services, About, Settings, or Quit, but had no one-click path to the latest briefing from the tray. Now the menu shows `Latest Briefing` between Pause/Resume and Services; clicking it raises the main window and navigates to `#/briefing` (the actual briefing route, per `twin-briefing.js`). Closes AC#4 of the (now-closed) #191 tray epic.

### Why this matters

The tray is the only surface that's always visible — it's where the user reaches when they want to peek without context-switching to a full window. "What's my latest briefing" is the single most common reason to peek; making it one tray click instead of "open the dashboard, find the briefing link, click" matches the discoverability the original AC called for.

## [0.6.46.0] - 2026-05-17

### Removed

- **Dropped `capability_recipes` table (closes #325).** Migration 027 created the table as a v1 vehicle for the static JSON recipes shipped in #181, with a comment noting it would become prompt-driven via #189. That migration happened: `packages/policy-prompts/prompts/recipe-recommendation/` is the live source (prompt + schema + 3 eval fixtures), and the capability-engine routes through `runPrompt('recipe-recommendation', ...)`. Full source audit confirms zero remaining references to the table outside its creation migration — no repository, no read site, no write site, no seed. Migration 053 (`DROP TABLE IF EXISTS capability_recipes`) makes the schema reflect the live behavior. The note on migration 027 is updated to point at 053 so the history reads cleanly on databases stamped pre-053.

### Why this matters

Dead schema is a paper cut every time someone reads `pnpm db:schema` output or wonders whether to wire a new feature into the table. Removing it makes the prompt-driven recipe path the only path, and removes the "is this still used?" question for the next person who touches the capability-engine. Decomposed out of #306 (closed today as a catch-all superseded by its 4 children).

## [0.6.45.0] - 2026-05-17

### Changed

- **SQL-pushdown `authoringTier` filter on `searchSemantic` (closes #300).** The `MemoryPort.searchSemantic(query, k, options?)` surface now accepts a third `options` argument with `authoringTier?: readonly string[]`. CRDB-backed adapters push the filter into `WHERE metadata->>'authoringTier' = ANY($N)` on both the text and vector legs of the RRF fold, so the caller asks for `k` results and gets up to `k` MATCHING results — no more over-fetch + client-side narrowing.
- **Caller change in `apps/api/src/draft-email-setup.ts`.** `buildAuthoredExamplesPort()` now passes `{ authoringTier: ['user_sent_originated', 'user_sent_reply'] }` to `searchSemantic` and drops the `OVER_FETCH_FACTOR=3` + `MIN_FETCH_FLOOR=6` constants entirely. With native pushdown, the candidate pool is filtered before RRF runs, so the cosine-similarity ranking isn't defeated by noisy inbox tiers dominating the top-k.
- **New `SearchSemanticOptions` interface in `@skytwin/memory-port`.** Documented contract: implementations SHOULD push the filter natively; adapters that cannot SHOULD polyfill (fetch generous pool, filter, slice). MemPalace adapter is empty-fallback today so the filter is accepted and ignored; CLI-shellout `GbrainMemoryPort` polyfills client-side from the gbrain CLI's JSON output (over-fetches `max(k*4, 40)` when a filter is set, narrows, then early-exits at `k`).
- **Migration 052: inverted index on `brain_pages.metadata`.** Adds `CREATE INVERTED INDEX brain_pages_metadata_idx ON brain_pages (metadata)`. CRDB inverted indexes on JSONB support the `->>` text-accessor equality / ANY predicates the #300 filter uses, so the planner narrows by the index before applying ts_rank / cosine — avoids a per-user scan on corpora with tens of thousands of pages.
- **Tests pinning the SQL-pushdown contract.** 6 new tests in `memory-gbrain-crdb-adapter`'s `in-memory-repository.test.ts` (text + vector + hybrid filter narrows, empty array = no filter, non-string tier values rejected, missing-metadata pages dropped under filter), 2 new tests in `memory-gbrain`'s `embedded-port.test.ts` (options.authoringTier threads through to backend), and the `draft-email-setup.test.ts` regression suite updated to pin the new contract (mock honors the filter, asserts no over-fetch).

### Why this matters

The draft-email generator was over-fetching `k * 3` (floor 6) hits, then client-side-filtering down to user-authored tiers. On noisy corpora (e.g. a user with thousands of inbox emails and dozens of sent ones), the candidate pool's top scores were dominated by inbox-tier matches — and the cosine-similarity ranking the RRF fold relies on never saw the authored hits because they fell off the over-fetch window. Pushing the filter into SQL means the cosine-similarity scoring loop only ever sees rows the caller wants, so retrieval quality scales with corpus size without runaway memory transfer.

## [0.6.44.0] - 2026-05-17

### Added

- **Draft-email approval-UI surface (closes #303).** `draft_email` candidates now render with a dedicated card in the approvals queue instead of the generic `renderActionDetails` shape. The user sees the inline body, examplesUsed-derived grounding subtitle, optional prompt-details disclosure, and can edit the draft before clicking "Send this draft" — the textarea's current value is what gets sent.
- **`renderDraftEmailCard` component** (`apps/web/public/js/components/draft-card.js`). Reads `parameters.draftBody / examplesUsed / replyToFrom / replyToSubject` and `confidence` from the CandidateAction. Confidence wording: HIGH → "high confidence", MODERATE → "moderate confidence", LOW → "review carefully — limited grounding". Grounding subtitle: "Drafted from N of your prior emails to <sender> and similar senders." Never uses "AI-generated" / "LLM" — it's "your draft" / "the draft" throughout.
- **Edit-before-approve API contract.** `POST /api/approvals/:requestId/respond` accepts an optional `editedBody` string on the body. The route's draft-email branch overrides `candidateAction.parameters.draftBody` with the edited value before the policy check + execution router runs. Original stored body remains in the approval row for the audit trail; only the in-flight action is mutated.
- **`resolveDraftEditOverride` + `applyDraftEditOverride` pure helpers** (`apps/api/src/routes/draft-edit-merge.ts`). Override rules — fire only when ALL hold: (a) actionType is `draft_email` (guards against misuse on other action types), (b) editedBody is a string, (c) non-whitespace content (whitespace-only blanks a real draft — user almost certainly meant Discard). The strict guards prevent a misused field from accidentally overwriting unrelated parameters.
- **9 new tests** in `draft-edit-merge.test.ts`: actionType guard (4 cases), non-string guard (4 cases), whitespace-only guard (3 cases), long-body acceptance, in-place mutation, no-mutation-when-skip, preserves-other-parameters, refuses-on-non-draft-action.

### Layout

The card replaces `renderStandardCard` for `draft_email` actions:
- Header: `📧 Draft reply to "<subject or sender>"` (truncated at 60 chars)
- Subtitle: grounding line + confidence
- Inbound metadata: `Re: <subject> · To: <sender>`
- Editable textarea (rows auto-sized 4–12 based on draft content)
- `<details>` disclosure: examples used, why-this-draft, estimated cost
- Actions: `Send this draft` (primary) / `Discard` (outline) / optional reason input

### Out of scope (matches issue body)

- Regenerate button — deferred. The candidate generator's idempotency + cost-gate semantics for re-runs need their own design pass.
- Multi-turn refinement ("make it shorter") — future feature.
- Drafts inbox surface — drafts live in the normal approvals queue for v1.

## [0.6.43.0] - 2026-05-17

### Added

- **`ExplanationRecord.capabilityProvenanceNodeId` populated end-to-end (closes #305).** The field was declared on the type but never written to the DB — the parent epic #189 closed without finalizing the population path. Migration 051 adds `explanation_records.capability_provenance_node_id UUID` with the FK + partial index applied out-of-line in the same migration (idempotent `ADD CONSTRAINT explanation_records_capability_node_fk FOREIGN KEY ... REFERENCES capability_provenance_nodes(id) ON DELETE SET NULL`). `explanationRepository.create()` accepts the field, the adapter threads it through, and `ExplanationGenerator.generate()` reads `outcome.selectedAction?.capabilityProvenanceNodeId` from the candidate. New optional field on `CandidateAction` carries the id forward from candidate-generation through to the explanation row.
- **6 new tests**: 3 in `explanation-generator.test.ts` (field threads through on capability-pipeline action; undefined on engine-originated action; undefined on no-action outcome), 3 in `explanation-repository.test.ts` (column written when set; NULL when omitted; NULL when explicitly null).

### Lineage view now walks action → explanation → provenance node

Concretely, this query now resolves the chain:
```sql
SELECT er.*, cpn.node_type, cpn.ref_table, cpn.ref_id
FROM explanation_records er
JOIN capability_provenance_nodes cpn
  ON cpn.id = er.capability_provenance_node_id
WHERE er.decision_id = $1;
```

### Not yet wired (intentionally deferred)

- **Candidate generators don't stamp the field today.** The plumbing accepts it from any candidate that sets it; no current generator (rule-based, LLM-strategy, draft-email, sender-aware) does. The MCP-host candidate-suggestion path is the natural future consumer — when an MCP-backed candidate is generated, it should look up the most-recent `install` provenance node for the source server and stamp it. That's a follow-up that lands when the MCP-host candidate path itself lands (currently `@skytwin/mcp-host` is execution-only, not generation).
- Until that follow-up ships, all explanation rows have `capability_provenance_node_id = NULL`. The plumbing is exercised by tests only.

## [0.6.42.0] - 2026-05-17

### Added

- **Eval-bench gate wired into `buildDraftEmailGenerator` (closes #314).** The fifth and final AND-gate on top of the four established in #295 / #299 / #301 / #302. A user can manually flip `drafts_enabled = true`, but the generator still refuses to construct until `twin_profiles.drafts_eval_passed_at IS NOT NULL` — proving the eval bench cleared all metric thresholds (voice / topical / length) on a corpus large enough to trust (#301's `minCorpusSize` floor). This is the quality gate on top of the opt-in gate: "the generator produces drafts you would actually send" must be proven on a held-out corpus before drafts can fire for this user.
- The check runs AFTER `drafts_enabled` (so the staged-rollout cohort costs at most one extra DB read, never two) and BEFORE cost-gate construction. Same fail-closed contract as the per-user flag: a transient DB error treats the gate as off, so `/api/events/ingest` never rejects.
- File docstring updated from "two flags" / "four gates" framing to the canonical five-gate AND. New tests pin: (a) per-user-ON + eval-NOT-passed returns null, (b) per-user-OFF short-circuits before the eval read, (c) eval-bench read errors fail closed.

### Drafts feature is now structurally complete

With #314 merged, every gate the design called for is in place:

| Gate | Source | Default | What it gates |
|------|--------|---------|---------------|
| Env flag | `SKYTWIN_DRAFTS_ENABLED` | off | Global incident kill-switch |
| LlmClient | per-user `ai_provider_settings` | absent | Provider chain to route to |
| Per-user opt-in | `twin_profiles.drafts_enabled` (#302) | FALSE | Staged rollout |
| Eval bench passed | `twin_profiles.drafts_eval_passed_at` (#301 + #314) | NULL | Quality on held-out corpus |
| Cost gate | call cap + spend cap (#299) | 100/day, $0/day until configured | Runtime cost bound |

Remaining pre-flip work is operational, not structural: write a corpus loader for the eval bench, run it for the first opt-in users, tune thresholds against real distributions, surface the draft candidate in the approval UI (#303). The deploy decision itself (#283) is unblocked.

## [0.6.41.0] - 2026-05-17

### Added

- **Draft-email eval bench (closes #301).** Quality gate that must clear before any user has `drafts_enabled` flipped on. The bench scores generated drafts against the user's actual sent replies on three metrics:
  - **Voice** — bigram-jaccard between the draft and the actual reply. The issue's spec proposed embedding cosine; we ship bigram-jaccard as a pure-function surrogate (the memory-port doesn't expose an embed-only primitive today, and bigram-overlap captures "is this in my voice" at acceptable fidelity with zero infra cost). Migrating to embedding cosine when the memory layer exposes an embed primitive is a clean drop-in swap.
  - **Topical** — content-word jaccard between draft and actual reply, with stop words filtered. Lower-fidelity than LLM-as-judge but free and deterministic. The LLM-judge variant is filed as a documented follow-up.
  - **Length** — |z-score| of draft length against the user's reply length distribution. Threshold: within 2σ (per the issue spec).
- **`runEvalBench(pairs, stats, thresholds?)`** in `@skytwin/decision-engine`. Pure: takes pre-generated drafts in `EvalPair` rows plus user reply stats, returns `{ corpusSize, voicePassRate, topicalPassRate, lengthPassRate, overallPassRate, passed, thresholds, notes, pairs[] }`. The caller is responsible for the corpus loader (gmail history → pairs) and the draft generator callback — keeping the bench testable without an LLM in the loop.
- **`DEFAULT_EVAL_THRESHOLDS`** — voiceJaccardMin 0.25, topicalJaccardMin 0.3, lengthSigmaMax 2, overallPassRateMin 0.8, **minCorpusSize 25**. Per Copilot review: a single perfectly-matched pair can no longer green-light a user; the run must hit the corpus floor before `passed: true` is possible. Starting points; tune after the first real run.
- **Audit trail.** New `draft_email_eval_runs` table (migration 050) stores one row per run with metric scores, threshold-pass booleans, and the thresholds captured at run time. Newest-first index on `(user_id, ran_at DESC)`.
- **Per-user gate column.** `twin_profiles.drafts_eval_passed_at TIMESTAMPTZ` — non-NULL means the user's most-recent passing run timestamp. `recordRun()` stamps this column inside the same transaction as the insert on `result.passed === true`.
- **`twinRepository.isDraftsEvalPassed(userId)` / `getDraftsEvalPassedAt(userId)` / `clearDraftsEvalPass(userId)`** for the dashboard / settings UI to display eval status and (operator-side) manually roll back a passing gate when a follow-up run regresses.
- **33 new tests** across `eval-bench.test.ts` (per-metric voice / topical / length, stop-word filtering, stddev=0 degenerate case, runner aggregate pass/fail, confidence levels, threshold defaults, **jaccard-empty-returns-0 + minCorpusSize gate from Copilot review**), `twin-repository.test.ts` (6 new for the eval getters/setters), and `draft-email-eval-runs-repository.test.ts` (transaction shape, conditional twin_profiles update on pass, JSONB threshold serialization, latest/list reads).

### Fixed (post-Copilot)

- **`jaccard(empty, empty)` whitewashed short replies as perfect match.** "ok" vs "no" both tokenize to zero bigrams / zero content words; the old code returned 1, scoring them as perfectly aligned. Fixed to return 0 — empty evidence means failed similarity.
- **No minimum corpus size could green-light a user from a single perfectly-matched pair.** Added `minCorpusSize` (default 25; issue spec suggested 50-100). `passed: true` now requires the corpus size threshold AND per-metric pass rates.

### Not addressed (intentionally deferred)

- **Wiring `drafts_eval_passed_at` into `buildDraftEmailGenerator` as a fifth AND-gate.** Now that #299 (cost gating) and #301 (this PR) both touch `buildDraftEmailGenerator`'s surrounding logic, the hookup is a small follow-up that lands AFTER both PRs merge: one `await twinRepository.isDraftsEvalPassed(userId)` check between the per-user flag check and the LlmClient construction, plus a test update. Until that follow-up ships, the eval bench is a measurement tool — running it doesn't gate generator construction.
- **Embedding-cosine voice metric.** Bigram-jaccard surrogate ships now.
- **LLM-as-judge topical metric.** Content-word jaccard ships now; the LLM-judge variant proposed in the issue is more sensitive but expensive (one LLM call per eval pair). The cost-gating from #299 needs to flow into the eval runs themselves before that can ship.
- **Corpus loader from Gmail.** The bench is pure — it consumes pre-loaded `EvalPair` rows. Loading them from `signals` table (filtered to authoringTier `inbox_personal` / `inbox_work` paired with same-thread `user_sent_reply`) is its own work, filed as follow-up.

## [0.6.38.1] - 2026-05-17

### Fixed (post-/review + Copilot)

- **Cost-gate enforcement was effectively a no-op for cloud drafts (Copilot caught two issues).**
  - The spend gate called `SpendTracker.checkDailyLimit`, which is read-only — it never wrote to `spend_records`. Successful draft LLM calls landed in `draft_email_calls` only, so `getDailyTotal()` never accumulated draft spend; the daily spend cap would have to be reached via OTHER spend paths before draft generation refused. **Fixed** by switching to `spendRepository.checkAndRecordSpend`, which atomically reads SUM, compares to cap, and INSERTs a reservation row in one CockroachDB serializable transaction.
  - The atomic reservation also fixes the TOCTOU race the read-only check had: two parallel signal ingests for the same user could both observe `current_total + estimate <= cap` and proceed to the LLM, collectively exceeding the cap.
- **Per-day CALL cap had the same TOCTOU race.** The old shape was COUNT-then-later-INSERT (the INSERT happened in `record()`, after the LLM call), so parallel ingests could each pass the cap check before any ledger row existed. **Fixed** with a new `draftEmailCallsRepository.checkAndReserveCall` that does SELECT COUNT + INSERT inside one transaction, mirroring the spend-side pattern. The gate now reserves the call ledger row at check-time; `record()` updates the row's `provider` and `succeeded` fields with the actual outcome.
- **The pre-call cost estimate didn't survive provider fall-through.** The candidate generator recorded `this.provider` (the gate's pre-call estimate of the cheapest provider) on the ledger. If embedded was estimated but tripped a circuit breaker and the chain fell through to cloud, the call landed on the ledger as zero-cost. **Fixed** by passing `LlmResponse.provider` (the actual provider that served the request) to `gate.record()`. The gate now reconciles the spend reservation based on the actual provider: embedded/Ollama actual → reconcile to 0 cents; cloud actual → leave at the estimate (existing decision-pipeline can refine `actual_cost_cents` later from real token counts).
- **`TwinProfileRow` type didn't include `drafts_daily_call_cap`.** The new setter returned a row whose type omitted the very column the caller just set. **Fixed** in `packages/db/src/types.ts` — symmetric with the existing `drafts_enabled` field added in #302.
- **Test name "SUM is NULL" misnamed the assertion.** The repo uses `COUNT(*)`, not `SUM(...)`. Renamed and the docstring now explains the defensive intent.
- 8 new tests added across `draft-email-calls-repository.test.ts` (atomic-reserve happy path, cap-reached refusal path, updateOutcome happy/missing paths) and `cost-gate.test.ts` (reservation handle returned on allow, reconcile-to-zero on cloud-fallback-to-local, reconcile-to-zero on LLM failure, no-reconcile on zero-cost-call failure, swallow-reconcile-errors). Existing tests rewritten to match the new mock surface.

### Not addressed (intentionally deferred)

- **Double DB read for AI providers (Copilot's perf comment).** `apps/api/src/draft-email-setup.ts:resolveDraftCostShape` reads `ai_provider_settings` to pick the cheapest provider; `apps/api/src/routes/events.ts:buildLlmClientForUser` reads the same table to build the primary LlmClient. Plumbing the rows through requires changing `buildDraftEmailGenerator`'s signature and the events.ts call site — bigger touch than the rest of this fix-up batch. Filed as follow-up in #283 sub-issues. Latency impact is one indexed-lookup query per signal ingest for opted-in users, which the per-user feature flag's default-FALSE shields almost everyone from.

## [0.6.38.0] - 2026-05-17

### Added

- **Draft-email cost gating (closes #299).** Last gate before any user can have the draft-email feature actually turned on. The wiring in #295 and the per-user flag in #302 left the runtime unbounded: every email signal with `requiresResponse: true` triggered an LLM call, with spend bounded only by the provider's per-token price and the inbound rate. This PR adds three complementary gates:
  - **Per-user per-day call cap.** New `twin_profiles.drafts_daily_call_cap INT NOT NULL DEFAULT 100` (migration 048) plus a new `draft_email_calls` ledger table. Each attempted LLM call writes one row regardless of outcome; the gate counts rows in the trailing 24h against the cap. Default 100/day is conservative; tunable via `twinRepository.setDraftsDailyCallCap`. Failed calls are counted too — a flapping provider can't bypass the cap by retrying.
  - **Per-user per-day spend cap.** Wires the existing `AutonomySettings.maxDailySpendCents` enforcement (via `SpendTracker.checkDailyLimit`) into the draft path. Conservative per-call cost estimate (5 cents) for cloud providers, 0 for embedded/Ollama. Zero-cost calls always pass the spend check; only cloud-provider paths can hit the ceiling.
  - **Trivial-signal short-circuit.** Pure-function classifier (`isTrivialAutoEmail`) catches inbounds that slipped past `gmail-connector.ts:inferEmailType` — noreply senders, mailer-daemon bounces, OOO subjects, auto-reply confirmations, unsubscribe-confirmed mail. Runs BEFORE the memory port and BEFORE the LLM, so a misclassified inbound never burns either dependency.
- **Cost-preferred provider ordering.** When wiring the generator, `apps/api/src/draft-email-setup.ts` now reads the user's enabled AI providers and picks the cost-cheapest first (embedded / Ollama before cloud). Drives the cost estimate passed to the gate — users with embedded configured get a 0-cent estimate and effectively unlimited spend headroom for drafts. Users on cloud-only get the 5-cent conservative estimate. The user's primary `priority` column still controls non-draft paths.
- **Architecture: `CostGatePort` interface.** Lives in `@skytwin/decision-engine` so the engine layer doesn't pull in `@skytwin/db`. The DB-backed `DbCostGate` is in `apps/api/src/cost-gate.ts`. `DraftEmailCandidateGenerator` accepts an optional `costGate` constructor option; back-compat preserved for callers that pass the legacy numeric `exampleCount` positional arg.
- **22 new tests** across `cost-gate.test.ts` (pure-function classifier × 4 buckets, sender / OOO / auto-reply / unsubscribe), `draft-email-candidate.test.ts` (gate refusal short-circuits memory + LLM, ledger records on success AND failure, gate-record errors don't lose the candidate, back-compat exampleCount path), `draft-email-calls-repository.test.ts` (count / record / window-tuning), `twin-repository.test.ts` (cap getter / setter / validation), `cost-gate.test.ts` in api (DbCostGate happy / refuse / zero-cost passes / ledger errors swallow).

### Out of scope (still owed before flipping the per-user flag on)

- **#301 (eval bench)** — must clear voice / topical / length thresholds before any user is opted in.
- **#300 (SQL pushdown on `AuthoredExamplesPort`)** — pure optimization; not a blocker.
- **#303 (approval-UI surface)** — the candidate lands in the existing approval pipeline, but the dashboard doesn't have a draft-specific render yet.
## [0.6.37.0] - 2026-05-17

### Added

- **Per-user draft-email feature flag (closes #302).** The `SKYTWIN_DRAFTS_ENABLED` env var that #295 introduced was a single global knob — appropriate for internal dogfood, but wrong for staged rollout. Added `twin_profiles.drafts_enabled BOOLEAN NOT NULL DEFAULT FALSE` (migration 047) plus `twinRepository.isDraftsEnabled` (narrow single-column read for the hot path) and `setDraftsEnabled` (for the eventual dashboard toggle). `buildDraftEmailGenerator` is now async and gates on a four-way AND: env on → LlmClient present → providers configured → per-user opt-in. Default-off path stays roundtrip-free — the env check short-circuits before any DB query. Default for existing users is FALSE: nobody is auto-opted-in by the migration.
- The env var stays as the global incident kill-switch — flipping it OFF disables the feature for everyone in one command, no DB writes needed. Effective state is `env_on AND per_user_on`.
- The per-user flag read is wrapped in a try/catch that fails closed: a transient DB error (pool exhaustion, migration window with the column not yet visible) returns null instead of propagating, so a flag-read failure can never take down `/api/events/ingest`. Caching the per-user boolean with invalidation from `setDraftsEnabled` is left as a follow-up; the read is a single-column SELECT on a unique-indexed column.
- Six new repository tests pin the contract (narrow SELECT, fail-closed on missing row, UPDATE shape with RETURNING + updated_at touch); four new setup tests pin the gating (env-off short-circuits before DB roundtrip, per-user-off returns null even with env on, all-four-gates-on returns the generator, and DB-error fails closed without rejecting).

## [0.6.35.0] - 2026-05-17

### Added

- **Daily + weekly briefings are now actually generated (partial close of #304).** `runBriefingGeneratorJob` shipped with the codebase but never ran — the worker's poll loop didn't kick it off. The worker now fires it on two independent single-flight + revert-on-failure schedules: daily on a 24h interval, weekly on a 7-day interval. Same fire-and-forget pattern as the relationship-tier backfill (#282), so signal ingestion is never blocked.
- Cadences are **intervals since last START in this worker process**, not UTC-day buckets. On a worker restart the interval resets, so a rapid restart can produce one extra briefing per cadence (briefing INSERT has no ON CONFLICT guard, so the duplicate row lands). For v1 this is acceptable noise; per-UTC-day idempotency is a follow-up. The "7am user-local" / "Sunday morning" targets in the original spec remain aspirational — requires per-user timezone awareness the worker doesn't have yet.
- Briefings run without an `LlmClient` for now (the deterministic Markdown template path). The adaptive briefing-prose path requires per-user LLM client setup that lives in the API; threading that into the worker is a separate follow-up.

### Not addressed (intentionally deferred)

- **`runPromotionEligibilityCheckJob` is NOT wired** in this PR. Its only side-effect is the SSE emit, and the worker has no `sseManager` — that lives in apps/api. Without a worker→API SSE bridge, calling the job would be logging-only (eligibility computed but never offered to the user, never applied to the tier). The job's docstring now says so explicitly. Tracked in #310 (the SSE-bridge prerequisite). The earlier version of this changelog entry claimed the DB-side tier ceremony runs from the worker — that was inaccurate; Copilot caught it on review.

## [0.6.34.0] - 2026-05-16

### Changed

- **Relationship-tier backfill no longer runs sequentially inside the connector poll loop (closes #282).** The daily backfill was invoked from `apps/worker/src/index.ts` as `await runRelationshipTierBackfillJob(uc.userId)` per user, sequentially. Once a single user crosses ~100k pages / ~1M signals in the 90d window, the per-user pass walks meaningful CPU and SQL time; sequential iteration across all users could starve the connector poll loop for minutes, delaying signal ingestion. The backfill now runs on a fire-and-forget scheduler with a single-flight guard: the poll loop checks "did 24h pass since the last START?" and kicks off `runRelationshipTierBackfillBatch` without awaiting. Inside the batch: worker-pool concurrency (3 users in parallel pulling from a shared queue, so a slow user doesn't block the next chunk), per-user timeout (5 minutes), and per-user error isolation. Signal ingestion is never blocked by backfill work; cadence is preserved at the 24h minimum. A scheduler-level batch failure (the helper itself rejects, distinct from per-user errors) reverts the start-timestamp so the next poll cycle retries immediately rather than waiting another 24h.
- New `apps/worker/src/jobs/relationship-tier-scheduler.ts` carries the batch helper. Seven tests in `relationship-tier-scheduler.test.ts` pin the contract: empty-list short-circuit, per-user invocation, worker-pool concurrency cap, per-user failure isolation, end-to-end timeout via `Promise.race` + `setTimeout`, sensible production timeout constant, slow-user-does-not-block-others.

## [0.6.33.0] - 2026-05-16

### Changed

- **Stale `TODO(#189)` markers re-pointed to live follow-up issues.** #189 was a 50h epic that closed without finishing several of its acceptance criteria. The orphaned TODOs scattered across the codebase pointed at the closed issue, so anyone reading "Tracked in #189" couldn't find the actual current status. Three new issues replace it:
  - **#304** — wire `promotion-eligibility-check` + `briefing-generator` jobs into the worker (both written, neither scheduled). `apps/worker/src/jobs/promotion-eligibility-check.ts` and `briefing-generator.ts` docstrings updated.
  - **#305** — populate `ExplanationRecord.capabilityProvenanceNodeId` in the action-execution path so the provenance lineage view can walk from action → explanation. `packages/shared-types/src/explanation.ts` docstring updated.
  - **#306** — catch-all for the remaining #189 deferred work: `oauth_quirks.json` deletion + `runPrompt('oauth-recovery', ...)`, `reverse-capability-intent` prompt wiring, decision-action-execution linkage, `registry_id` on `spend_records`. Five source-file refs updated (`capabilities.ts` × 4 sites, `spend-repository.ts` × 2 sites, `assistant.js` × 2 sites).
- No behavior change. The dormant code stays dormant; only the comment refs are corrected so future readers find the right tracking issue.

## [0.6.31.0] - 2026-05-16

### Fixed

- **`relationshipTier` no longer over-promotes contacts whose received and sent activity never overlapped on the same day (closes #281).** `computeBidirectionalThreadCounts` shipped in #251 Phase 2 with a looser definition than its docstring implied — the SQL `INNER JOIN sent s ON s.contact = r.contact` was a per-contact Cartesian product, so `COUNT(DISTINCT r.day)` returned every received-day as long as any sent activity existed for that contact anywhere in the 90d window. A user who got 10 newsletter-style emails and replied to one of them at month-start would have that contact promoted to `core`. The in-memory mirror had the same shape (`for (received) if (sent.has) recvDays.size`). Both backends now compute the strict same-day intersection: `JOIN ... ON (contact, day)` in SQL, set-intersection in-memory.
- **Relationship-tier thresholds re-tuned to match the intersection's expected distribution.** Old bands assumed the loose definition (`core >= 10`, `frequent >= 3`, `occasional >= 1`). Under intersection those would push almost every user to `occasional` / `stranger`. New bands: `core >= 5`, `frequent >= 2`, `occasional >= 1`. Most personal users have ≤5 same-day exchanges in 90d even with their closest contacts, so the new bands trade some compression at the top end for more useful separation at the bottom. Calibration against a representative corpus is a follow-up; these are the conservative initial bands and should be revisited once aggregate distribution data from real users is available.
- Existing in-memory test suite rewritten for intersection semantics; two new tests explicitly pin the intersection-vs-window-presence distinction so a future refactor can't re-introduce the original bug. Worker `relationship-tier-backfill.test.ts` updated to use a count that lands in the new `frequent` band (3 instead of 5).

## [0.6.30.0] - 2026-05-16

### Added

- **`DraftEmailCandidateGenerator` is now wired into the events ingestion pipeline behind a dark-deploy env flag (closes the wiring sub-task of #283).** The generator landed as an opt-in building block in #277 / #251 Phase 4 but was never composed into `DecisionMaker.evaluate`. This PR adds the composition path: when `SKYTWIN_DRAFTS_ENABLED=true` AND the user has an LLM client configured, the route builds a `CompositeCandidateGenerator` that runs the existing rule-based / LLM strategy alongside the draft generator in parallel; the engine's scoring layer picks across the merged candidate list. Default is off (`SKYTWIN_DRAFTS_ENABLED` unset → no construction cost, no memory roundtrip — zero added latency). A memory-port-backed `AuthoredExamplesPort` filters semantic hits client-side to `authoringTier IN ('user_sent_originated', 'user_sent_reply')`; over-fetches 3× to compensate for the client-side narrow. New `CompositeCandidateGenerator` is exported from `@skytwin/decision-engine` for re-use — it runs N generators in parallel, concatenates results, and drops a single generator's failure without losing the others.

#### Still owed before this can be flipped on for any user

These are tracked in #283 and remain open:
- **Cost gating.** Every `generate()` call invokes the LLM. There is no per-user per-day cap or per-user spend cap surfaced from the policy engine yet. Bound only by the provider's per-token price and the inbound rate.
- **SQL pushdown on `AuthoredExamplesPort`.** Today's client-side filter works for typical k (≤10) but doesn't scale to high-k or noisy corpora.
- **Eval bench against real LLM.** Need a held-out paired inbound→reply corpus, then voice / topical / length thresholds gating the flip.
- **Per-user feature flag.** Today's `SKYTWIN_DRAFTS_ENABLED` is process-wide. A `drafts_enabled` field on `twin_profile` or `brain_settings` is the per-user form.
- **Approval-UI surface for `draft_email` candidates.** The candidate flows through the normal pipeline, but the dashboard doesn't yet highlight `parameters.examplesUsed`, the prompt, or inline-edit-before-approving.

## [0.6.29.0] - 2026-05-15

### Fixed

- **A re-ingested signal no longer runs its action a second time.** Sibling/successor to v0.6.28.0's `decision:blocked-by-policy` gate, but a real correctness fix this time. The decision row was idempotent on `(user_id, signal_id)` (migration 023), the approval row was idempotent on `decision_id` (migration 046), but the events route still ran the full pipeline on every ingestion — policy evaluation, candidate persistence, outcome upsert, and on the auto-execute path the **action itself**. A worker dedupe miss or at-least-once delivery retry of an auto-executed signal would run the action twice (send the same email a second time, etc.). The route now short-circuits after `decisionRepository.create` returns `created: false`: fetches the previous outcome via `decisionRepositoryAdapter.getOutcome`, fetches the existing approval via the new `approvalRepository.findByDecisionId`, and returns the same response shape the first ingest produced (plus a `reIngested: true` marker). The downstream side-effects — `saveCandidates` row stacking, the `decision_outcomes` ON CONFLICT DO UPDATE overwriting the original outcome, `approvalRepository.create`, and execution — all skip. If the previous outcome row is missing (the first attempt crashed between `saveDecision` and `saveOutcome`), the route falls through to the normal pipeline so the work eventually completes — `created: false` alone means "another attempt wrote the decision row," not "the previous attempt finished."
- The per-emit `decisionCreated` gate that v0.6.28.0 introduced for `decision:blocked-by-policy` is now redundant and removed. The short-circuit handles the recoverable case (no emit) and the fall-through case correctly fires the SSE (the user never saw it on the failed first attempt). Two regression tests in `events-routes.test.ts` pin both paths.

### Fixed (post-/review)

- **Auto-execute hang detection.** The first cut treated "saved outcome row" as the only recoverability bar — but `saveOutcome` runs inside `decisionMaker.evaluate` **before** the action executes. A first attempt that saved its outcome and then hung mid-execution (network timeout on the action's HTTP call, killed worker between `createPlan` and `createResult`) would have been silently absorbed by the short-circuit, leaving the action stuck without ever retrying. The recovery check now also requires a terminal `execution_result` row for auto-execute outcomes; if the previous attempt has a plan but no result, the route falls through and runs the pipeline to completion so the action actually finishes. Two new tests in `events-routes.test.ts` pin both cases (terminal result → short-circuit, no result → fall-through).
- `approvalRepository.findByDecisionId` now filters out `status = 'cleaned'` rows so a soft-deleted escalation-only approval doesn't surface a stale id in the re-ingestion response.

## [0.6.28.0] - 2026-05-15

### Fixed

- **The dashboard no longer re-flashes the "blocked by policy" indicator when the same signal is re-ingested.** Sibling to the `approval:new` fix in v0.6.27.0. The `decisions` table's `(user_id, signal_id)` idempotency (migration 023) makes re-ingestion a DB-level no-op — `decisionRepository.create` returns the existing row instead of inserting. But `events.ts` re-ran interpretation + policy and re-fired `decision:blocked-by-policy` on every ingestion, re-flashing the "blocked" indicator for a signal the user had already seen blocked. `decisionRepository.create` now returns `{ row, created }` (same shape as `approvalRepository.create`); the route gates the SSE emit on `created: true`. Logs an audit breadcrumb on suppression. Foundation for the broader correctness fix in the follow-up PR (auto-execute path also re-runs the action on re-ingestion; tracked separately).

## [0.6.27.0] - 2026-05-15

### Fixed

- **The dashboard no longer re-flashes the approvals badge when the same signal is re-ingested.** Migration 046 (the unique index on `approval_requests(decision_id)`) and `INSERT ... ON CONFLICT DO NOTHING` in `approvalRepository.create` made re-ingestion a DB-level no-op — no duplicate row. But the `events.ts` and `assistant.ts` routes both fired the `approval:new` SSE event on every successful `create()` return, including the ON-CONFLICT path. Every re-ingestion of an already-seen signal re-played the "new approval" toast, re-bumped the unread counter, and re-flashed the approvals badge for an approval the user had already opened (or already resolved). `approvalRepository.create` now returns `{ row, created }` where `created` is true only on a genuinely new insert. Both call sites gate the `approval:new` SSE emit on `created`, so a re-ingestion no longer fires the duplicate notification. The HTTP response still surfaces the existing approval so API callers see consistent bookkeeping, and the upstream signal-recording emits (`memory:page-indexed`) intentionally still fire per ingestion — only the `approval:new` notification is suppressed. The suppression path logs an audit breadcrumb (`Suppressed approval:new SSE for re-ingested signal`) so an operator investigating "why no notification?" can confirm the re-ingestion was recognised and intentionally silenced rather than lost.
- Regression tests in `events-routes.test.ts` pin both directions: a `created: true` return must emit `approval:new`, a `created: false` return must not.

## [0.6.26.0] - 2026-05-15

### Fixed

- **Migration runner no longer silently swallows `23505` (unique-violation) errors.** The runner has always absorbed certain errors so that re-running a migration is a no-op rather than a hard failure — duplicate-table, duplicate-column, duplicate-constraint. It also absorbed `23505` (unique-violation / "duplicate key") under the same banner, on the assumption that a re-run seed `INSERT` should be safe. But `23505` is also what CockroachDB returns when a `CREATE UNIQUE INDEX` is blocked by residual duplicates, when an `INSERT ... SELECT` backfill hits a real collision, when an `ALTER TABLE ... ADD CONSTRAINT UNIQUE` fails on dirty data — and all of those used to be silently absorbed too. Migration 046 (the approval_requests unique index) surfaced this: a previous version added a self-verify check that caught the case for that specific migration, but the runner-level bug remained. The runner now has one rule: `23505` always surfaces, even when its message happens to contain "already exists" (an explicit code-anchored guard runs before the message-substring fallback). Seed migrations that need re-run safety use `INSERT ... ON CONFLICT DO NOTHING` to mark the intent at the statement level, which is the idiomatic Postgres pattern (no current migration relies on the old swallow — `grep -E '^\s*INSERT' packages/db/src/migrations/*.sql` returns zero hits; the one bare `INSERT` token in the corpus is inside a `--` comment in `039-model-downloads.sql`).

### Fixed (post-/review)

- **Schema-batch path uses the same idempotency rule as the per-statement loop.** The initial `pool.query(schema)` block previously used a raw `message.includes('already exists')` check, which would have swallowed a 23505 whose message happens to contain that phrase — inconsistent with the per-statement loop's stricter behaviour. Both paths now call `isIdempotentError`.
- **The 23505 anti-swallow handles numeric codes and code-less errors.** node-postgres always surfaces `code` as a string, but other pg clients (or a hand-built driver) may return a number, and a driver that elides `code` entirely on a 23505 still carries the canonical "duplicate key value" message. The guard now uses `String(code) === '23505'` and also vetoes `message.includes('duplicate key')` before the DDL message fallback runs.
- New tests pin both: numeric-coded 23505, code-less 23505-shaped Error, and the schema-batch consistency.

## [0.6.25.0] - 2026-05-14

### Fixed

- **The approvals page no longer shows every email twice.** Every inbound signal (email, calendar event) was being ingested more than once: the worker that polls Gmail had two processes running concurrently, each with its own in-memory dedup that couldn't see the other's, so both forwarded every signal. The decision layer absorbed the double-ingestion (it is idempotent on the signal id), but the approval-creation step had no such guard — each re-ingestion stacked another `approval_request` row for the same decision. The result was a "Needs your OK" page with every email duplicated, some 3-4 times. Approval creation is now idempotent: a unique index on `approval_requests(decision_id)` plus `INSERT ... ON CONFLICT DO NOTHING`, so a re-ingested signal is a transparent no-op instead of a duplicate. A one-time data migration removes the duplicate rows that had already accumulated, keeping the row the user actually acted on — a resolved approval is kept over a still-pending duplicate, so an approve/reject is never lost. The orphaned second worker process was the operational trigger and has been stopped.

### Fixed (post-/review)

- The migration fails loudly instead of silently if its unique index cannot be created. CockroachDB reports a `CREATE UNIQUE INDEX` blocked by residual duplicates as SQLSTATE 23505, which the migration runner's idempotency guard treats as "already applied" — so a failed index build would have left the migration reporting success with no index, and the new `ON CONFLICT` code would then error on every insert. The migration now verifies the unique index is actually in place (correct name, column, and uniqueness) and raises a non-swallowable error if it is not.
- The dedup keeps the right row. The pre-landing review flagged that "keep the earliest" could discard an approval the user had already approved or rejected in favor of an older still-pending duplicate. The dedup now orders resolved rows ahead of pending ones, so a user's response is never the row that gets dropped.
- `approvalRepository.create` throws a typed error rather than returning `undefined` if its post-conflict lookup finds nothing, and that lookup is scoped by `user_id` to match every other read in the repository.

## [0.6.24.0] - 2026-05-14

### Fixed

- **New users were silently trapped at the `observer` trust tier — their "Needs your OK" page stayed empty forever.** Every new user starts at `observer`. The twin was evaluating their incoming signals, generating candidate actions, and assessing risk — but `observer` was wired as deny-all in *two* places: the trust-tier gate (`checkTrustTierGating`) returned `allowed: false`, and a built-in policy rule (`rule_observer_no_execute`) carried `effect: 'deny'`. So every candidate action was policy-denied, the decision pipeline never selected an action, and no approval request was ever created. Nothing reached the approvals page. Worse, it was a permanent trap: promotion out of `observer` requires 10 approvals, and a denied action produces no approval to ever approve — so a new user could never earn their way to the `suggest` tier. `observer` is now **allow-with-approval**, identical to `suggest`: the twin's proposed actions surface as approval requests you can approve, reject, or edit, and those approvals are what earn promotion. The twin still **never auto-executes** at `observer` — every action requires your explicit click (`decision-maker`'s `shouldAutoExecute()` independently gates this, unchanged). Note: `observer` and `suggest` are now mechanically near-identical (both allow-with-approval, neither auto-executes) — the trust-tier ladder is due for a separate rethink.

### Fixed (post-/review)

- **The trust tier's approval requirement is now explicitly preserved through the quiet-hours early return.** With `observer` no longer hard-denying, it flows through code paths it never reached before — including the quiet-hours escalation. The pre-landing review flagged that the tier's "requires approval" signal survived that early return only by coincidence (the quiet-hours decision happens to also require approval). It is now threaded through deliberately, the same way the injection-guard confirmation level already is — so a future change to quiet-hours behavior can't silently drop an `observer`/`suggest` user's approval requirement.
- **Added an end-to-end regression test** wiring the real `PolicyEvaluator` into the real `DecisionMaker` for an `observer`-tier decision, asserting the outcome has a non-null selected action, requires approval, and does not auto-execute. The existing tests only proved the fix in fragments (the policy layer in isolation, the decision-maker with a mocked evaluator); none proved the integrated behavior — exactly the gap that let the original bug ship.
- Synced `docs/safety-model.md`, which still described `observer` as "no autonomous action of any kind" / "records what it *would have* done" — the pre-fix mental model.

## [0.6.23.2] - 2026-05-14

### Fixed

- **The app no longer boots as a "phantom" user.** A `skytwin_userId` left in `localStorage` could outlive the user row it pointed at — the dev database gets reseeded between sessions, or a user is deleted — and the app would boot straight into that dead id. Everything keyed on the user then silently broke: the dashboard rendered, but "Connect Google", approvals, and the rest operated on a user the server had never heard of (and the OAuth callback would then quietly reattach the connection to whoever owned the email). On boot the app now verifies the stored id against the server before committing to it: if the server says the id doesn't exist (`404`) or isn't the one this client's session authenticates as (`401/403` — a stale token or a forged `?userId=` link), it clears the whole SkyTwin `localStorage` slate (id, onboarded flag, session token, per-user state) and sends the user back through onboarding. Transient errors (offline, 5xx) still boot normally so a blip doesn't log anyone out.

## [unreleased] — Documentary-poisoning injection guard

Closes the "no risk this thing rm/rf's me" concern: a defense against
prompt injection through content the twin reads but the user did not
author — inbound email bodies, files found during the idle filesystem
crawl, web pages, calendar invites from other people. An attacker who
gets text in front of the twin can no longer steer it into a
destructive action that auto-executes.

The guard has two independent axes, deliberately kept separate:

- **Provenance** — *where* the decision originated. `user_originated`
  (the user authored it), `trusted_context` (their own profile /
  learned state), or `untrusted_external` (everything else). This is
  the load-bearing security boundary: it never inspects what the
  injected text says, only where the triggering content came from, so
  a brand-new injection vector still lands in `untrusted_external` and
  is still gated. Missing provenance fails safe — treated as untrusted.
- **Severity** — *how destructive* the action shape is. `none`,
  `destructive` (delete mail/events, revoke tokens, bulk operations),
  or `extreme` (shell execution, recursive filesystem deletion,
  database drops, account deletion). A pattern-based hint — including
  detection of destructive command signatures smuggled through string
  parameters — layered on top to choose one-click vs. two-click.

Nothing is hard-denied. Every action keeps a path to execution; the
guard only ever escalates to human confirmation:

- **extreme severity** → two-step token-gated confirmation, regardless
  of provenance or trust tier. Two distinct clicks — documentary-
  poisoned content cannot click twice on its own.
- **destructive severity** → one explicit confirmation, never
  auto-executes, regardless of trust tier.
- **untrusted provenance + irreversible** → one explicit confirmation.
- **untrusted provenance + reversible + low-severity** → still
  auto-executes (the carve-out that keeps "auto-archive newsletters"
  working — reversible content cannot escape its own blast radius).

Where it lives:

- `@skytwin/shared-types` — `ActionProvenance` / `ActionSeverity` /
  `ConfirmationLevel` types, `classifyActionSeverity()`,
  `resolveActionProvenance()`, and `evaluateInjectionGuard()` — the
  matrix as one pure function so the policy engine and the execution
  router consult identical logic and cannot drift.
- `@skytwin/policy-engine` — `checkInjectionGuard()` runs in
  `evaluate()` before every other check (so a quiet-hours early return
  cannot skip it) and threads `confirmationLevel` through every
  approval path.
- `@skytwin/decision-engine` — the situation interpreter stamps
  provenance from the signal's authoring tier + source; candidate
  generators inherit it; the outcome carries `confirmationLevel`.
- `@skytwin/execution-router` — a defense-in-depth backstop refuses to
  auto-execute any action the guard would have escalated. Approved-
  execution callers pass `{ approved: true }` and pass through.
- `apps/api` — the approvals `/respond` endpoint enforces dual
  confirmation: the first POST mints a one-time token, the second must
  carry it within a 10-minute window. The `assistant` chat path is
  marked `user_originated` (the user instructing the twin in their own
  words is the one genuinely trusted instruction source).
- `apps/web` — the approvals page renders a two-step confirm for
  dual-confirmation actions.
- Migration `045-approval-confirmation-level.sql` — adds
  `confirmation_level`, `first_confirmed_at`, `confirmation_token` to
  `approval_requests` (all `ADD COLUMN IF NOT EXISTS`, idempotent).

Tests: 63 new — 24 for the classifier + provenance resolver + the full
provenance×severity matrix (`@skytwin/shared-types`), 14 for the
policy-engine guard + `evaluate()` integration, 8 for the
execution-router backstop, 5 for the approval-repository changes,
12 for the dual-confirmation step classifier (token mismatch, length
mismatch, expired window, boundary).

## [0.6.23.1] - 2026-05-14

### Fixed

- **Desktop "Connect Google" from the dashboard now updates the page when it finishes.** The dashboard's connect handler never passed an `onComplete` callback, so after a desktop sign-in completed in the system browser the "Connect Google" hero just sat there until a manual reload. It now re-renders the dashboard when the connection lands — and busts the 30-second OAuth-status cache first, so the re-render reflects the new state instead of the stale "not connected" one. (Follow-up to #284; settings and setup already had this, the dashboard was missed.)
- **`@skytwin/db` test suite no longer flakes on whether a database is reachable.** `migration-runner.test.ts` imports `001-initial.ts` for its pure helpers, but that module had an unguarded top-level `main()` call that opened a DB connection and called `process.exit` on failure — so the test file passed or failed depending on whether CockroachDB happened to be up. `main()` is now guarded to run only when the file is executed directly as a CLI, not when imported. (Regression from #284.)

## [0.6.22.0] - 2026-05-14

Fixes that unblock running SkyTwin locally and natively: Google sign-in now works in the desktop app, the web server boots under Express 5, and `pnpm db:migrate` runs clean on a fresh database.

### Fixed

- **Google sign-in in the desktop app.** The desktop OAuth flow appended `|desktop` to the HMAC-signed `state` parameter *after* the server signed it, so every desktop sign-in came back from Google as `400 Invalid OAuth state: signature mismatch`. The `desktop` flag is now passed to the authorize endpoint at sign time and folded into the signed payload server-side. Users can complete Google sign-in (including passkeys) from the desktop app again.
- **Web server boot under Express 5.** `apps/web/src/index.ts` used bare `*` wildcard routes, which Express 5's path parser rejects — the dashboard crashed on startup. Route patterns updated to `/api/*splat` and `/*splat`.
- **`pnpm db:migrate` on a fresh database.** The migration runner now treats `duplicate constraint name` as an idempotent skip (matching the existing `already exists` / `duplicate key` handling), and a stray `;` inside a SQL comment in migration 039 that split the `CREATE TABLE` mid-statement is removed.

### Added

- `apps/web/public/js/google-signin.js` — shared `startGoogleSignIn()` helper. All four Google sign-in entry points (settings, setup, dashboard, onboarding) route through it, so desktop builds open OAuth in the system browser instead of the Electron `BrowserWindow`, which cannot handle passkeys.

### Changed

- `.gitignore` now excludes `.skytwin-pids`, the runtime process-tracking file written by `bin/skytwin-dev`.
- Root `package.json` version synced to the `VERSION` file (was drifted at `0.5.4.0`).

## [unreleased] — End-to-end Phase 1+2+4 loop test (#251 Phase 5)

Final phase of the #251 arc. Adds an end-to-end loop test that exercises the full composition of Phase 1 (tier-aware retrieval), Phase 2 (relationshipTier axis), and Phase 4 (`DraftEmailCandidateGenerator`) through a single realistic scenario — without any real LLM or CRDB.

### What ships

- `packages/decision-engine/src/__tests__/draft-email-e2e-loop.test.ts` — 4 scenarios exercising the layer composition:
  - **Authored-only grounding**: user has 4 authored emails + 3 newsletter / automated noise pages. Inbound `requiresResponse: true` email lands. Generator produces one `draft_email`. The prompt must contain authored bodies and must NOT contain newsletter / automated bodies. `examplesUsed: 4`.
  - **LOW-confidence fallback**: authored corpus is empty (only noise). Generator still drafts but `examplesUsed: 0` and reasoning warns about voice-match weakness.
  - **Cost gate**: `requiresResponse: false` inbound — generator skips entirely. LLM is never invoked.
  - **Phase 2 in spirit**: two authored examples with equal topical overlap; the `core`-tagged one renders before the `occasional`-tagged one in the prompt.

### `AuthoredCorpusAdapter` example

The test ships a minimal `AuthoredExamplesPort` adapter that filters an in-memory corpus by `authoringTier ∈ {user_sent_originated, user_sent_reply}` and ranks by token-overlap with a small `core`-relationship boost. This is the wiring pattern callers should follow when adapting their `MemoryPort` to the generator — push the tier filter down to the SQL layer and let the RRF fold handle ranking.

### Why no real LLM here

Phase 4 already pins LLM-call shape, failure modes, and prompt structure with unit tests. The loop test's job is the *dataflow* — does the generator pass the right examples to the right LLM call when wired against a realistic adapter — and that's verified by inspecting the prompt the fake LLM receives. Real-LLM evals (voice match, drift, regressions) belong in their own dedicated suite, gated by API-key presence and run on a slower cadence than CI.

### Phase 5 closing notes

The five phases of #251 deliberately ordered to compound:

1. Phase 1.1 fixed Layer 2 weighting so authored content reliably wins close calls without leapfrogging strong primaries.
2. Phase 2 added a second axis (`relationshipTier`) so close contacts get the bonus even when authoring tier is the same.
3. Phase 3 generalized the vocabulary across channels (calendar) so the same retrieval logic powers everything.
4. Phase 4 shipped the building-block (`DraftEmailCandidateGenerator`) that uses the tier-aware retrieval as voice grounding.
5. Phase 5 (this) is the smoke test that the layers actually compose as designed.

The marquee feature — twin-drafted replies in the user's voice — is now end-to-end wired. The deploy decision (when to flip on, eval gates, cost gating, which LLM provider) lives outside the engine and is a separate roll-out item.

## [unreleased] — draft_email candidate generator (#251 Phase 4)

The marquee feature Layers 1+2+3 were building toward. When an inbound email needs a reply, a new candidate generator drafts the body in the user's voice using their authored corpus as few-shot grounding.

### What's new

- `packages/decision-engine/src/strategies/draft-email-candidate.ts` — `DraftEmailCandidateGenerator` implementing `CandidateGenerator`. Fires only when `decision.domain === 'email'` and `rawData.requiresResponse` is truthy. Produces one `CandidateAction` with `actionType: 'draft_email'`.
- `AuthoredExamplesPort` interface — the minimal port the generator needs from the memory layer. Decoupled from `@skytwin/memory-port` so the decision-engine package stays leaf-level.
- `buildDraftPrompt(input)` — exported helper that renders the few-shot prompt. Structure is load-bearing for voice match, so it's testable directly.

### Wiring approach: opt-in

The generator is **exported but not wired into `DecisionMaker.evaluate` by default**. The deploy decision (which LLM client, when to flip it on, eval gates) lives outside the decision-engine layer. Callers instantiate it explicitly and add it to their generator list. This phase ships the building block.

### Confidence and safety

- `reversible: true` (the candidate is reversible up to the user clicking Send; the policy engine handles the actual send threshold)
- `MODERATE` confidence when ≥ 3 authored examples were available, `LOW` otherwise — the approval UI surfaces "drafted from N of your prior emails" via `parameters.examplesUsed` so the user sees the grounding strength
- Always requires explicit approval at v1 regardless of trust tier (no auto-send)
- Fail-open on memory error (drafts without grounding, `LOW` confidence, copy explicitly warns about weak voice match)
- Fail-closed on LLM error (returns no candidate rather than shipping a bad template-y draft)

### Prompt shape

- System prompt instructs the LLM to match voice/length/opening/closing/vocabulary from the few-shot examples; output ONLY the body, no subject/signature/preamble; 1–4 short paragraphs
- Few-shot examples are truncated at `MAX_EXAMPLE_CHARS = 800` to stop a 5KB email from dominating context
- Default `DEFAULT_AUTHORED_EXAMPLE_COUNT = 6` (~1500 prompt tokens budget for examples)
- Query for the memory search is composed from inbound subject + first body line + from address, capped at 500 chars

### Tests

20 cases in `__tests__/draft-email-candidate.test.ts`: domain gating (email + requiresResponse), happy-path candidate shape and parameter projection, confidence based on example count, fail-open / fail-closed on subsystem failure, rawData fallbacks (snippet → body, messageId → emailId), prompt rendering (with/without examples, truncation at MAX_EXAMPLE_CHARS, placeholder copy for empty fields), query construction (500-char cap, empty-field stripping).

## [unreleased] — Cross-channel tier: calendar events get authoringTier (#251 Phase 3)

Calendar events now carry the same `authoringTier` vocabulary as Gmail signals. The classification logic lives in `packages/connectors/src/calendar-authoring-tier.ts` and runs at signal-build time in `GoogleCalendarConnector.eventToSignal`. The result lands on `brain_pages.metadata.authoringTier` exactly like Gmail-derived pages do — same RRF fold, same Phase 1 additive bonuses, same Phase 2 relationship-tier composition.

### Mapping

| Calendar shape | AuthoringTier |
|---|---|
| User organized the event (organizer email = self) | `user_sent_originated` |
| Auto-generated event (Google Contacts birthdays, holidays feed) | `inbox_automated` |
| Multi-attendee invite the user is on (>2 attendees) | `inbox_broadcast` |
| 1-on-1 invite or shared calendar entry | `inbox_personal` |

`user_sent_reply` and `inbox_newsletter` aren't applicable to calendar and aren't used.

### Engine

- New file `packages/connectors/src/calendar-authoring-tier.ts` with `classifyCalendarAuthoringTier(input)`. Recognizes Google Contacts birthdays (`addressbook#contacts@`), holiday calendars (`en.usa#holiday@`), and weather feeds via regex.
- `GoogleCalendarConnector.eventToSignal` now calls the classifier and stamps both `authoringTier` and `from` (organizer email) on `signal.data`. The `from` field matters because the embedded port's `buildPageMetadata` reads it to populate `metadata.fromAddress` — that's what Phase 2's relationship-tier worker queries, and what the per-sender bulk-hide UI from PR #270 sends to.

### Why the vocabulary is reused (not extended)

The original #251 spec deliberately picked tier value names that generalize across channels — `user_sent_originated` reads as "user authored, fresh," not as "an email the user sent." Reusing the same enum keeps the retrieval pipeline channel-agnostic: one bonus table, one set of weights, one eval covers everything.

### Tests

- 8 cases in `calendar-authoring-tier.test.ts`: user-organized (case-insensitive), birthdays/holidays/weather → automated, multi-attendee → broadcast, 1-on-1 → personal, edge cases for empty `selfEmail`.

### Out of scope for this phase

- GitHub authoring tier — no GitHub connector currently in the codebase. The vocabulary is already channel-agnostic, so a future GitHub connector can stamp tiers the same way without engine changes.

## [unreleased] — relationshipTier: second retrieval axis (#251 Phase 2)

Adds a second dimension to gbrain's tier weighting: how strong the user's back-and-forth has been with the contact over the last 90 days. Composes additively with `authoringTier` from Phase 1.1.

### Tier bands

Computed from bidirectional thread count (days where the user both sent to AND received from the contact) over the last 90 days:

| Tier | Threshold | Examples |
|---|---|---|
| `core` | ≥ 10 bidirectional days | Spouse, manager, daily collaborators |
| `frequent` | 3–9 | Team members, vendors actually engaged with |
| `occasional` | 1–2 | Sporadic exchanges |
| `stranger` | 0 | Cold senders, broadcast lists, never-replied |

### Bonuses (normal calibration, additive, same scale as authoring)

- `core`: +0.004 — a page from a close contact gets a small boost
- `frequent`: +0.002
- `occasional`: 0
- `stranger`: 0 (promote-only, matching Phase 1.1's lesson)

Combined effect: an `inbox_personal` page from a `core` contact gets +0.004 (climbs ahead of a same-topic newsletter without authored sibling); a `user_sent_originated` to a `core` contact gets +0.005 + +0.004 = +0.009 (decisive on ambiguous queries).

### Engine

- **`tier-weights.ts`** gets `RelationshipTier` enum, `REL_*` calibration tables, `relationshipTierFromThreadCount` helper, and `tierBonus` now composes the relationship dimension additively after the authoring dimension.
- **`computeBidirectionalThreadCounts(userId, windowDays)`** new adapter helper. SQL: JOIN `brain_signals` self-join on contact address within the window, restricted to rows where one side has the `SENT` label and the other doesn't. Returns `Map<contactAddress, bidirectionalDays>`.
- **In-memory mirror** matches the CRDB SQL behaviour bit-for-bit.

### Worker

- **`runRelationshipTierBackfillJob(userId)`** (new): pulls the contact count map, walks recent pages, derives the tier band from each page's `metadata.fromAddress`, writes via `updatePageMetadata` only when the tier differs. Idempotent.
- Scheduled daily in `apps/worker/src/index.ts` (`RELATIONSHIP_TIER_BACKFILL_INTERVAL_MS = 24h`). Per-user, failures swallowed at user scope so one bad mailbox can't stall others.

### Dashboard

- The Recent pages indexed table gains a **Relationship** column with `core` / `frequent` / `occasional` / `stranger` badges alongside the existing authoring-tier badge.
- `/api/memory-config/dashboard` payload's `pages.recent[]` now includes `relationshipTier` projected from metadata.

### Tests

- 8 new unit tests in `tier-weights.test.ts` covering relationship-only bonuses, composition with authoring, sparse/dense calibration scaling, pinned-override composition, hidden-override drop, and `relationshipTierFromThreadCount` thresholds.
- 7 new worker tests in `relationship-tier-backfill.test.ts` covering per-tier derivation, lower-case normalization, unchanged detection, skipped (no `fromAddress`), failure isolation, find-throws → empty summary, 0-affected → counted as failed.
- All 70 turbo tasks green.

## [unreleased] — Layer 2 additive rewrite + default-on (#251 Phase 1)

Phase 1.1 + 1.2 of the multi-phase #251 plan. Replaces Layer 2's multiplicative tier weighting with additive bonuses, validates the result against both hash-trick and real-embedding evals, and flips the toggle on by default for new + existing users.

### Headline result (real embeddings, Ollama nomic-embed-text)

| Metric | pure-RRF | Phase-0 multiplier | **Phase 1 additive** |
|---|---|---|---|
| user_behavior MRR (n=3) | 0.667 | 1.000 | **1.000** |
| received_content MRR (n=3) | 1.000 | 0.537 | **0.833** |
| neutral MRR (n=1) | 1.000 | 1.000 | 1.000 |
| aggregate MRR primary | 0.857 | 0.804 | **0.929** |

received_content MRR recovered from 0.537 → 0.833. Aggregate MRR primary went *above* the pure-RRF baseline. The remaining 0.83-vs-1.0 gap on received_content is the q4 case where the user wrote a reply about the alert — surfacing their own reply first is defensible product behavior, not a bug.

### Engine

- **`tier-weights.ts` rewrite.** `tierBonus(metadata, calibration)` replaces `tierMultiplier`. Returns an additive bonus (~±0.005 in the normal band) rather than a multiplier. Sized so a bonus can flip close calls (rank-2 vs rank-1, raw diff ~0.0003) but not leapfrog strong matches.
- **Promote-only configuration.** All received tier bonuses are 0; only authored tiers get a positive bonus. The real-embedding eval showed any negative bonus pushes legitimate primary hits below distractors on queries that don't have an authored alternative.
- **`HIDDEN_SENTINEL` / `PINNED_BOOST` constants** make the userOverride composition explicit. Hidden returns `Number.NEGATIVE_INFINITY`; the RRF fold special-cases that to drop the page.
- **Floor-ratio gate retained.** Default 0.85. The additive approach still benefits from the gate when real embeddings give spurious vector overlap to topically-unrelated content. Without the gate, q5's "GitHub Actions CI failed" query returned q1's Series B authored content above the primary; with the gate, the cross-query authored leak goes away.
- **Back-compat aliases.** `tierMultiplier` and `buildTierWeightFn` are re-exported as deprecated aliases of `tierBonus` / `buildTierBonusFn` so internal callers keep working in this PR. Cleanup is a separate follow-up.

### Default-on flip (Phase 1.2)

- **Migration 044** flips `brain_settings.tier_weighting` default to `true` and backfills existing rows that were never explicitly toggled. Users can still opt out via Settings → Memory backend.
- **All in-code defaults** updated to match: `parseSettingsRow`, in-memory `upsertSettings`, repository `upsertSettings`, route GET default.

### Tests

- `tier-weights.test.ts` rewritten for additive semantics. 19 tests covering all three calibrations, userOverride composition, brief-reply downweight, calibration thresholds, back-compat aliases.
- `rrf.test.ts` tier-weight section rewritten. Includes a new test verifying that a weak-match authored page does NOT leapfrog a strong primary even with the additive bonus + gate.
- `tier-ablation-eval.test.ts` guardrail bars tightened: `received_content ≥ 0.55` (hash-trick), `≥ 0.75` (real embeddings). Both above the new measured floor of 0.58 / 0.83.

## [unreleased] — Real-embedding ablation result for Layer 2 (#251 follow-up)

Ran the tier-ablation eval against a real semantic embedding model (Ollama's `nomic-embed-text`) to validate the hypothesis that hash-trick spurious overlap was the cause of the `received_content` MRR regression first surfaced in PR #260. **The hypothesis was wrong.**

### Result

| Metric | pure-RRF | tier-weighted |
|---|---|---|
| user_behavior MRR (n=3) | 0.667 | **1.000** |
| received_content MRR (n=3) | 1.000 | **~0.54** |
| neutral MRR (n=1) | 1.000 | 1.000 |

The `received_content` number with real embeddings (~0.54) is essentially identical to the hash-trick floor (0.542 in PR #260). Hash-trick was not the cause.

### Diagnosis

The regression is structural to the multiplicative weighting approach:

- `user_sent_originated × 1.5` vs `inbox_automated × 0.8` produces a **1.875×** swing. Any page within 53% of the top raw score that's `authored_*` will leapfrog a strong-but-demoted primary hit.
- The floor-ratio gate (default 0.85) helps but isn't enough. With real semantic embeddings, an authored page from a *completely unrelated* query (e.g. q1 Series B pitch) has non-trivial similarity to q5 ("GitHub Actions CI failure") — enough to land in the candidate pool above the threshold. The 1.5× boost on that unrelated content then beats the 0.8× demote on the actually-relevant primary.
- Diagnostic dump from the eval confirms: q5's primary lands at rank 8/9 with tier-on, behind three authored pages from unrelated queries plus several distractors.

### Decision

**Layer 2 stays opt-in.** The default-on rollout is blocked on a structural fix, not on environment / corpus / eval setup. The likely path:

- Switch from multiplicative weighting (`score *= tier_weight`) to additive bonuses (`score += tier_bonus`) sized to flip close calls without leapfrogging strong matches. Estimated +0.005 for authored-originated, -0.005 for automated, on raw RRF scores in the 0.016–0.033 range — enough to break ties without overwhelming relevance.
- Re-run the ablation with the additive approach. Target: received_content MRR ≥ 0.95 while preserving user_behavior MRR = 1.0.

That's a separate sub-issue — out of scope for this PR.

### What ships now

- New opt-in test branch in `tier-ablation-eval.test.ts` gated on `RUN_REAL_EMBEDDING_EVAL=1`. Anyone with Ollama on `localhost:11434` and `nomic-embed-text` pulled can reproduce. Defaults respect `OPENAI_EMBEDDING_BASE_URL` / `OPENAI_EMBEDDING_MODEL` / `OPENAI_EMBEDDING_API_KEY` so a real OpenAI key works too.
- `runOneMode` in the eval helper takes an optional `embedding` provider so the same harness drives both the always-on (hash-trick) and opt-in (real) tests.

### Side note

This is exactly what the eval was designed to surface — and exactly the kind of negative-result-with-clear-next-step that justifies the engineering effort of building an eval guardrail. PR #260's `received_content ≥ 0.40` assertion held; we just learned where the real ceiling sits under the current design.

## [unreleased] — Authoring-tier backfill worker (#251 follow-up)

Pages indexed before Layer 1 of #251 (where the Gmail connector started stamping `authoringTier` on every signal) had no tier on their metadata — which meant the Layer 2 multiplier did nothing for them. This adds a worker job that retroactively fills in the tier for those pages, plus the connector keeps the raw headers needed to reclassify going forward.

### What's running now

- A new **`runTierBackfillJob`** worker runs hourly. It scans `brain_pages` for rows where `metadata->>'authoringTier' IS NULL`, joins on `brain_signals` via `source_ref`, and either:
  1. Copies `signal.data.authoringTier` to page metadata when it already exists (post-#252 ingest paths that bypassed the metadata projection for any reason — cheap and lossless).
  2. Runs the classifier locally on the raw `to` / `cc` / `inReplyTo` / `listUnsubscribe` / `listId` / `labels` headers (post-this-PR signal shape).
  3. Logs an "unreclassifiable" count and leaves the page alone (pre-Layer-1 signals that don't carry classification headers — full re-fetch from Gmail is a separate sub-issue).
- The Gmail connector now persists those raw header fields in `signal.data` so option (2) becomes available for every page indexed after this lands. Cost: a few extra short strings per row. The fields the classifier already consumed are now also queryable downstream.

### Why bother

Without this, existing-user corpora are silently stuck: their pages have no tier, so they see no Layer 2 benefit even if they enable the toggle. With it, the multiplier becomes useful on day one — the worker converges the back-catalog within a few passes (batch size 200, hourly cadence) and is a strict no-op once it's done.

The job is idempotent and bounded — re-running on a fully-tagged corpus does nothing because the find query filters on `metadata->>'authoringTier' IS NULL`.

### Engine

- **`findPagesMissingAuthoringTier(userId | null, limit)`** (new adapter helper): JOIN brain_pages ↔ brain_signals on `source_ref = id`, filter on tier-missing, optional user scope. Returns `{ page_id, user_id, signal_data }[]`.
- **`apps/worker/src/jobs/tier-backfill.ts`** (new): the worker job. Reclassifies via the two paths above, calls `updatePageMetadata` to write `{ authoringTier, fromAddress }`, returns a summary with attempted / copied-from-signal / reclassified / unreclassifiable / failed counts.
- **Gmail connector**: `messageToSignal` now stamps `to` / `cc` / `inReplyTo` / `listUnsubscribe` on `signal.data` alongside the existing fields. No behavior change to the classifier; just preserves the raw inputs for downstream reclassification.
- In-memory adapter mirror for tests.

### Tests

- 9 new worker unit tests (`tier-backfill.test.ts`) cover: signal-tier copy path, header reclassification (SENT label / List-Unsubscribe), unreclassifiable count, failed-update isolation, find-query throwing yields empty summary, fromAddress omission when missing, userId scoping, default null-scope.
- 4 new in-memory repository tests on `findPagesMissingAuthoringTier`: page-with-tier excluded, signal-missing page skipped, userId scoping, limit cap.

### Deferred

- Pre-#252 signals that don't carry classification headers stay untagged after this lands. Recovering those requires an OAuth-token-dependent re-fetch from Gmail — separate sub-issue, lower priority since each pass converges new ingest quickly.

## [unreleased] — Tier-aware privacy controls: pin / hide / hide-sender (#251 follow-up)

The memory dashboard's "Recent pages indexed" table now shows three action buttons per row: **Pin**, **Hide**, and **Hide sender**. The first two flip `metadata.userOverride` between `'pinned'`, `'hidden'`, and unset (the gbrain RRF fold already reads this — pinned doubles the rrfScore, hidden drops the page from search entirely). The third one bulk-hides every indexed page from the same sender — useful for tidying out a newsletter or transactional sender you don't want the twin learning from.

This is the privacy guardrail that gates Layer 2's default-on rollout. With it in place, users can keep tier-weighting enabled while still curating what the twin treats as signal.

### Engine work

- **`buildPageMetadata`** in `EmbeddedGbrainMemoryPort` now stamps `fromAddress` (lower-cased bare address from `data.from`) on every page that carries one. The bulk-hide action queries against this field, so it's a precondition for the sender action being useful. No schema change — `metadata` is JSONB.
- **`updatePageMetadata(userId, pageId, patch)`** (new repository helper): merges a JSONB patch into the page's metadata column, scoped by `user_id` so a caller can't mutate someone else's pages even if they hold a guessable id. Returns affected row count; 0 maps to 404 at the route layer.
- **`hideAllPagesFromSender(userId, fromAddress)`** (new): bulk `UPDATE` that sets `metadata.userOverride='hidden'` on every page where `metadata->>'fromAddress'` matches the supplied address (lower-cased). Returns affected row count for "hid N pages from X" toast feedback.
- Both helpers have matching in-memory mirrors for tests.

### API surface

- **`POST /api/memory-config/pages/:pageId/override`**. Body `{ override: 'pinned' | 'hidden' | null }`. 404 when the page doesn't exist or belongs to another user (deliberately doesn't distinguish, so a caller can't probe for foreign page-id existence).
- **`POST /api/memory-config/senders/hide`**. Body `{ fromAddress: string }`. Returns `{ ok: true, fromAddress, hidden: <count> }`.
- `GET /api/memory-config/dashboard` now includes `pages.recent[].fromAddress` so the UI knows what to send to the sender endpoint.

### Web

- New per-row actions on the Recent pages indexed table: Pin / Unpin, Hide / Unhide, Hide sender. Buttons swap their action depending on current state. The sender button only appears for pages with a `fromAddress` (i.e. email-derived). The bulk action surfaces a confirmation prompt before firing (since one click can hide hundreds of rows).

### Tests

- 5 new unit tests on the in-memory repository: `updatePageMetadata` merges + respects user ownership + 404s on missing pages; `hideAllPagesFromSender` matches case-insensitively, scopes by user, and reports 0 when nothing matches.
- 3 new embedded-port tests: `fromAddress` stamping lower-cases display-name addresses, handles bare addresses, omits when `data.from` is missing.
- 6 new memory-config-routes tests: per-page override rejects bogus values, accepts pinned/hidden/null, 404s on missing pages; sender bulk-hide rejects missing `fromAddress`, lower-cases on the wire, surfaces affected count; dashboard payload includes `userOverride` + `fromAddress`.

## [unreleased] — Layer 2 ablation eval + tuned multipliers + floor-ratio gate (#251 follow-up)

Stood up a labeled-retrieval ablation eval at
`packages/memory-gbrain/src/__tests__/tier-ablation-eval.test.ts` that runs
the same query set against the same corpus twice — once with
`tier_weighting=false` (pure RRF) and once with it on — and reports R@5,
P@5, and MRR-of-primary side-by-side, broken down by query class. Three
classes: `user_behavior` (the multiplier should lift these), `received_content`
(must not collapse), `neutral` (must not break).

### What we measured

Running on a hand-built 52-signal fixture (12 labeled + 40 distractors) with hash-trick embeddings:

| Metric | pure-RRF | tier-weighted |
|---|---|---|
| user_behavior MRR (n=3) | 0.667 | **1.000** |
| received_content MRR (n=3) | 1.000 | 0.542 |
| neutral MRR (n=1) | 1.000 | 1.000 |
| aggregate R@5 | 1.000 | 0.857 |

### What the eval surfaced

Two things, both real:

1. **Aggressive demote weights were structurally wrong.** Original normal-band multipliers (newsletter 0.4×, automated 0.2×) pushed primary-hit notifications BELOW the distractor pool. Layer 2 became unusable for "find my AWS billing alert" queries. **Fixed** by rebalancing to promote-strong/demote-soft: newsletter 0.85×, automated 0.8× in the normal band.

2. **Multiplicative weighting without a gate lets weak matches leapfrog strong ones.** RRF scores decay slowly: at the default `rrfK=60`, rank-1 = `1/(60+1) ≈ 0.0164`, rank-30 = `1/(60+30) ≈ 0.0111`. A rank-30 authored distractor at `0.0111 × 1.5 ≈ 0.0167` could beat a rank-1 received primary at `0.0164 × 0.8 ≈ 0.0131` — the curve is shallow enough that a small raw-score gap leaves room for the multiplier to flip the order. **Fixed** by adding `tierWeightFloorRatio` (default 0.85) to the RRF fold: only pages whose raw rrfScore is ≥ 85% of the top score are eligible for the multiplier. Tail-of-pool candidates stay at their unweighted score.

### What remains

`received_content` MRR is at 0.542 with hash-trick embeddings. The honest read: the multiplier still pushes the user's reply about a received item above the received item itself when both are in the result set. This is sometimes-right (the user usually wants their own response, not the raw notification) and sometimes-wrong (sometimes you really do want the raw alert). The number should improve with real OpenAI embeddings — most of the loss is from spurious hash-trick overlap promoting unrelated authored content into the candidate pool for received-content queries.

**Layer 2 stays beta / opt-in.** This eval is the gate, not the result. Default-on rollout is still blocked on (a) running this with OpenAI embeddings against a real-traffic corpus, (b) the tier-aware exclude UI from the privacy follow-up. The eval test now runs in CI as a permanent regression guardrail — anything that drops `user_behavior` MRR below `pure-RRF` or `received_content` MRR below 0.40 will fail.

### Engine changes

- **`rrf.ts`**: added `RrfFoldOptions.tierWeightFloorRatio` (default 0.85). Computes the top raw rrfScore before applying any multiplier; pages below `floorRatio * top` keep their unweighted score. Coerces non-finite multiplier returns to 1.0 and clamps negatives to 0 (same drop-the-page semantics as `userOverride: 'hidden'`).
- **`tier-weights.ts`**: rebalanced multiplier tables. Normal band is now `user_sent_originated` 1.5× / `user_sent_reply` 1.2× / `inbox_personal` 1.0× / `inbox_broadcast` 0.9× / `inbox_newsletter` 0.85× / `inbox_automated` 0.8×. Sparse and dense bands recalibrated to match the new asymmetry: promote strongly, demote softly.

### Tests

- New `tier-ablation-eval.test.ts` (1 ablation case + side-by-side report printed at the end of every run as a tuning artifact).
- New `tier-ablation-corpus.ts` fixture: 17 labeled signals (7 queries × authored/received variants) + 40 realistic-mix distractors (12% authored / 40% personal / 15% broadcast / 20% newsletter / 13% automated).
- Existing `tier-weights.test.ts` and `tier-weighted-retrieval.test.ts` updated to match the rebalanced multipliers. Brief-reply downweight test now compares against a full authored email (the load-bearing claim) instead of newsletter — softer demote means the brief reply no longer falls below newsletter, but it still falls below a proper-length authored email, which is the actual mechanism worth testing.

## [unreleased] — Authoring-tier weighting in gbrain retrieval (#251 Layer 2 + companion fields)

You can now flip a toggle in **Settings → Memory backend** that tells gbrain to treat the emails you *wrote* as higher-signal than the emails you *received* when ranking semantic-search results. A newsletter that mentions "board prep" stops out-ranking the strategy email you actually wrote about board prep. The toggle is **off by default** — we're gating Layer 2 on labeled-retrieval evals before flipping it on for everyone — but it's available today for anyone who wants to try it.

### What this changes for the user

- A new **"Weight what you wrote (Layer 2 — beta)"** card on Settings → Memory backend with a single toggle. Enabling it auto-detects your calibration band from how much you've written in the last 90 days (sparse / normal / dense) so a thin-sent corpus doesn't get over-amplified.
- The "What your twin remembers" dashboard now leads with a **Recent pages indexed** table that shows a small tier badge next to each page (`you wrote`, `you replied`, `personal`, `broadcast`, `newsletter`, `automated`, plus `📌 pinned` / `hidden` when the user has explicitly overridden). First-week product feel is no longer "1,247 newsletters" — it's "the things you wrote, plus the things sent to you, plus the noise."

### Engine work

- **Migration 043** adds `tier_weighting` (bool, default false) and `tier_calibration` (enum `sparse` / `normal` / `dense`, default `normal`) to `brain_settings`. Out-of-band: a fresh user gets reasonable defaults via `parseSettingsRow` even before the migration runs.
- **`packages/memory-gbrain-crdb-adapter/src/tier-weights.ts`** (new) — the multiplier table with three calibration bands. `user_sent_originated` ranges 1.2× / 1.5× / 2.0×; `inbox_newsletter` ranges 0.5× / 0.4× / 0.3×; etc. Composes orthogonally with `metadata.userOverride` (`pinned` doubles, `hidden` drops the page from results entirely) and includes a brief-reply downweight: an `authored_*` page whose body is shorter than 50 chars gets `inbox_personal` weight so a one-line "k" reply can't outrank a 500-word strategy email.
- **`rrf.ts`** accepts an optional `tierWeight(metadata)` callback. Default behaviour is pure RRF; passing the callback multiplies each accumulated rrfScore by the per-page weight before the final sort. `textRank` / `vectorRank` survive unchanged for observability.
- **`embedded-port.ts`** reads `brain_settings.tier_weighting` per-query; when on, it builds a tier-weight function for the user's calibration band and passes it through to `hybridSearch`. Lookups are best-effort: any DB error falls back to pure RRF rather than blocking the search.
- **`buildPageMetadata`** now stamps `bodyLen` on every page so the brief-reply downweight has something to read. Adds one field; no schema change.

### API surface

- `GET /api/memory-config` now returns `tierWeighting` and `tierCalibration` alongside the existing backend + capabilities + index fields. The dashboard reads it to render the toggle.
- `POST /api/memory-config/tier-weighting` (new). Body `{ enabled: boolean, calibration?: 'sparse' | 'normal' | 'dense' }`. On enable without an explicit `calibration`, the route counts `user_sent_*` pages from the last 90 days and picks the band from `calibrationFromSentVolume`. Falls back to `normal` on DB failure.
- `GET /api/memory-config/dashboard` now includes `pages.recent[]` (10 newest brain pages) with `authoringTier` + `userOverride` projected out of metadata. Embedding vectors are stripped from the wire response.

### Tests

- **16 unit tests** in `tier-weights.test.ts` cover the multiplier table for all three calibrations, `userOverride: pinned/hidden` composition, brief-reply downweight thresholds, and `calibrationFromSentVolume` thresholds.
- **3 new rrf.test.ts cases** exercise the `tierWeight` branch: a higher-base-rank newsletter falling behind a lower-base-rank authored page once weighting flips on, `hidden` dropping pages entirely, and `textRank` / `vectorRank` surviving the reorder.
- **5 end-to-end cases** in `tier-weighted-retrieval.test.ts` seed a mixed-tier corpus and assert the load-bearing claim: with `tier_weighting = true`, an authored page that ranks #2 on text alone reaches index 0 in the results. Also covers the per-user isolation invariant (one user with the flag on doesn't affect another with the flag off).
- **5 new memory-config-routes.test.ts cases** cover the new POST endpoint: invalid body, auto-recompute on enable, explicit `calibration` overrides the auto-recompute, disable doesn't recompute, and a DB failure during `countUserSentPages` falls back to `normal`.

### Deferred to follow-ups

- `relationshipTier` (separate axis for relationship strength, from bidirectional thread count) — separate sub-issue.
- Migration backfill that re-derives `authoringTier` for pages indexed pre-Layer 1 — separate concern from the live ingest path.
- Tier-aware exclude UI for the privacy story (per-thread "don't index from this") — sub-issue, will block flipping Layer 2 on by default.
- Layer 2 default-on rollout — gated on the labeled-relevant-doc eval improving recall@5 on a real production corpus.

## [unreleased] — Piper TTS backend + `/api/voice/synthesize` route (#187 AC#4)

### Fixed (post-Copilot review)

- `/api/voice` now mounts through `requireOwnership` so POST
  `/transcribe` and `/synthesize` can't be called with another
  user's `userId` in the body. The in-router
  `bindUserIdParamOwnership` only covered `:userId` path params,
  leaving body-userId POSTs structurally unprotected.
- `PiperTtsBackend.spawnPiper` switched stdout to `ignore` (was
  `pipe`). The WAV is read from `--output_file`, not stdout —
  leaving stdout piped without consuming it could block Piper
  once the OS pipe buffer filled. Matches the proven whisper-cli
  spawn pattern.
- Piper stdin now gets a trailing `\n` so the newline-delimited
  reader treats the input as one complete utterance instead of
  relying on EOF semantics. Matches the docstring; test updated.
- `/api/voice/synthesize` response field renamed from
  `durationBytes` to `audioBytes`. The former implied a time
  measurement; the value is a byte count of the WAV. New endpoint,
  no compat concern.

### Original change

Closes #187 AC#4. Mirrors the proven spawn pattern of
`LlamaCppTextBackend` and `WhisperCppSttBackend`. Four pieces:

- **`packages/embedded-llm/src/piper-tts-backend.ts`** —
  `PiperTtsBackend` implements `EmbeddedTtsPort`. Spawns `piper`
  with `--model <model.onnx> --output_file <tmp> --quiet`, writes
  text to stdin, reads the resulting WAV into a Buffer on
  successful exit. Cleans up the tempdir on both success and
  failure. Bounded inputs: text required, max 8000 chars; mismatched
  voice request fails hard rather than silently substituting.

- **`packages/embedded-llm/src/piper-tts-backend.ts` —
  `findFirstPiperModel(dir)`** locates the first `.onnx` voice
  model with a paired `.onnx.json` config (Piper requires both).
  Catches "stray .onnx, missing config" at boot instead of at
  synth time when the failure would be a confusing
  `NotAvailableError` chain.

- **`packages/embedded-llm/src/factory.ts` —
  `createEmbeddedTtsPort(overrides?)`**. Same shape as
  `createEmbeddedSttPort`: probe `runtime-detector` for a `piper`
  binary (env-var override → PATH lookup), then resolve a voice
  model (env-var override → first valid pair in the configured
  model dir). Falls back to `NullEmbeddedTtsPort` when either is
  missing — same contract the STT side already exposes.

- **`apps/api/src/routes/voice.ts`** — new `POST /api/voice/synthesize`
  consumer. Body `{ userId, text, voice? }` → response
  `{ audioBase64, durationBytes, voice }`. 503 + recovery hint when
  no piper binary is on PATH, matching the STT path's shape. The
  `GET /capabilities` endpoint now reports `stt` and `tts` capability
  blocks alongside the legacy STT-shaped fields so older clients
  keep working.

Tests: 15 new vitest cases for `PiperTtsBackend` + `findFirstPiperModel`
(mocked `node:child_process` + `node:fs` so they run hermetically with
no piper on the host). 9 new API tests for `/synthesize` and the
updated `/capabilities` shape. Full workspace: 70/70 turbo tasks
green; build clean.

What this does NOT ship (deliberate):

- **Bundled piper binary / voice model.** Still requires the operator
  to install piper-tts (`brew install piper-tts` on macOS,
  `apt install piper-tts` on Ubuntu) and drop an `.onnx` + matching
  `.onnx.json` config in the configured model dir. Bundling joins the
  same distribution work as #187 AC#1 (default GGUF) paired with
  #188 turnkey distribution.
- **Briefing → speech wiring.** The API surface is now reachable but
  the dashboard / mobile briefing screen doesn't yet auto-speak the
  current briefing. That's a UI follow-up gated on the existing
  briefing surface; the backend it needs is in main as of this PR.

## [unreleased] — Mobile voice recording module (#179 voice side)

### Fixed (post-Copilot review)

- `voice-service.ts` switched to `import type { SkyTwinApiClient }` —
  the client is only used as a type; importing it as a runtime value
  added unnecessary coupling and bundle weight.
- Removed the misleading "branch on `permission_denied`" hint from
  the `VoiceTranscriptError` docstring. Microphone-permission denial
  is handled inside `VoiceScreen` before this layer is reached;
  there is no `permission_denied` code in the union.
- `transcribeVoice` docstring corrected: the API enforces a 25MB
  *decoded* cap (~33MB base64), not "25MB base64."
- `openSystemSettings` now actually opens the OS settings page via
  `Linking.openSettings()` and falls back to the explanatory alert
  only when that's unavailable. One-tap recovery for permission
  denial instead of just an explainer.
- Permission-denial copy now acknowledges the temporary on-device
  audio file (read back as base64 for upload). The earlier "never
  store recordings anywhere besides your paired desktop" was
  technically inaccurate.
- Result-state UI label changed from "{X} of audio" to "Audio size:
  {X}" — `durationBytes` is a byte count, and the previous wording
  implied a time-based duration.

### Original change

The mobile app can now capture audio and ship it to the paired
desktop's `/api/voice/transcribe` (the route landed in PR #244). This
closes the code-bound half of #179 voice — the remaining work is QA on
physical devices, which has always been the actual blocker.

- **`apps/mobile/src/screens/VoiceScreen.tsx`** — new tab.
  Tap-to-record → tap-to-stop → upload → transcript. Six-state machine
  (`idle`, `denied`, `recording`, `processing`, `result`, `error`) with
  the recording lifecycle driven by `useAudioRecorder` from
  `expo-audio`. Pulse animation + tabular-numeric timer while
  recording; permission-denied screen has a "How to fix" affordance.

- **`apps/mobile/src/services/voice-service.ts`** — pure helpers.
  `audioFileToBase64(uri)` reads the recorder's output via
  `expo-file-system`'s `File.base64()` API. `transcribeRecording(...)`
  orchestrates base64 → upload → result mapping with stable error
  codes (`no_audio` / `read_failed` / `whisper_unavailable` /
  `network` / `unknown`) so the UI can branch on cause without
  parsing free-form error strings.

- **`apps/mobile/src/services/api-client.ts`** — new
  `transcribeVoice(userId, audioBase64, language?)` method. Uses the
  existing request layer with a 60s timeout (whisper's first-run model
  load can take several seconds on cold start; the default 10s would
  abort mid-transcribe). `TranscribeResponse` type added to the
  response-type block.

- **`apps/mobile/app.json`** — `NSMicrophoneUsageDescription` on iOS,
  `RECORD_AUDIO` on Android, `expo-audio` plugin entry. Permission
  copy emphasizes "sent to your paired SkyTwin desktop for on-device
  transcription" so the install prompt matches the privacy story.

- **`apps/mobile/src/App.tsx`** — `voice` added to the `MainTab`
  enum, registered in the `renderContent` switch, and a "Voice"
  `TabButton` placed between Capabilities and Dashboard.

- **`apps/mobile/package.json`** — adds `expo-audio: ~55.0.14` and
  `expo-file-system: ~55.0.19` (the latter was already transitively
  installed; declared explicitly so the dep is auditable).

Test plan: 11 new vitest cases in `voice-service.test.ts` mocking the
`File.base64()` path and `fetch` for the transcribe endpoint. The
test file mirrors the inlined-class pattern at `api-client.test.ts:23`
to keep React Native imports out of Node's test runner. Full mobile
suite: 165 tests, 163 passing + 2 skipped (skips are unrelated
discovery tests). Full workspace: 70/70 turbo tasks green;
`pnpm build --concurrency=1` clean.

What this does NOT ship (deliberate, follow-ups):

- **TTS playback.** The screen displays the transcript but does not
  speak responses back. That's a separate flow that pairs with #187
  AC#4 (desktop Piper TTS) once a `piper` binary is on PATH.
- **"Send to twin" hand-off.** The transcript is shown but not yet
  pipelined to the assistant or the decision pipeline. A follow-up
  will route the transcribed text through the existing chat /
  assistant route once that mobile surface lands.
- **Physical-device QA.** The Expo SDK 55 `expo-audio` API works in
  the simulator but real-device behavior (silent-mode switch, AirPods
  routing, background record interruption) needs a physical device to
  verify.

## [unreleased] — Per-Lifebook briefing prose (#193 follow-up)

### Fixed (post-Copilot round 1)

- **Tier-promotion rows now flow into per-Lifebook briefings.** The
  prior filter checked `payload.registryId`, but `tier_promotion`
  payloads carry `{ from, to, reason }` (no registry id) and
  reference the server via `server_id`. `gatherBriefingData` now
  computes a `server_id → registry_id` map and `filterDataByLifebook`
  uses it to attribute promotions to the right lifebook.
- **N+1 query pattern eliminated.** The orchestrator now calls
  `gatherBriefingData` ONCE per user and passes the bundle through
  both the global briefing and every per-Lifebook briefing. Per-
  lifebook DB cost dropped from "2 repo calls + 1 query per
  lifebook" to "filter the in-memory bundle."
- **Empty-allowlist footgun fixed.** `filterDataByLifebook` now
  returns an EMPTY bundle when the lifebook has no
  `suggested_capabilities`, instead of returning the unfiltered
  global bundle. Previously a scoped call with an empty allowlist
  would have written a global briefing under the domain's label.
- **`listForUser` scoped to global by default.** Adding the
  `domain_name` column would otherwise have silently interleaved
  per-Lifebook rows into the existing twin-briefings history. New
  `opts.includeDomainScoped` lets callers opt in. New
  `listForUserDomain()` mirror serves the per-domain history.
- **6 new route-level tests** for `GET /lifebook/:domain/latest`
  (returns briefing when present, returns `null` when absent,
  forwards cadence, ignores bogus cadence, 403 on cross-user,
  400 on missing userId).

### Original change

Closes the last of the three #193 Child 1 follow-ups deferred by
PR #242 (capabilities Lifebook filter shipped in #256; provenance
wing filter shipped in #257; this one). The weekly briefing worker
now emits, in addition to the existing global briefing, one
per-Lifebook briefing for each visible domain with activity in the
window. The lifebook page renders the per-domain briefing when one
exists.

### Migration

- `042-briefing-domain.sql` — adds nullable `domain_name STRING`
  column to `twin_briefings`. NULL preserves the historical global-
  briefing semantic untouched. A string value scopes the briefing
  to that lifebook's domain (matching `lifebooks.domain_name`).
  Partial index `(user_id, domain_name, generated_at DESC) WHERE
  domain_name IS NOT NULL` keeps per-domain queries fast without
  bloating storage for global rows.

### Repository

- `briefingRepository.create()` accepts an optional `domainName`.
- `briefingRepository.getLatestForUser()` now explicitly scopes to
  `domain_name IS NULL` — the historical method only ever served
  global briefings, so the implicit semantic is now explicit.
- New `briefingRepository.getLatestForUserDomain(userId, domain,
  cadence?)` for the per-Lifebook surface.

### Worker

- `apps/worker/src/jobs/briefing-generator.ts` extends the job:
  after writing the global briefing, fetch the user's visible
  lifebooks and emit one per-domain briefing per lifebook with
  events in the window. Events are filtered by
  `registry_id ∈ lifebook.suggested_capabilities` — the same set
  the domain extractor proposed. Empty filtered sets are skipped
  (a "nothing happened in Health this week" briefing is noise).
  Per-lifebook failures are caught and logged so one broken domain
  doesn't kill the rest.
- The prompt carries an optional `{{domain}}` input; the
  template's `{{#if domain}}` block adds a one-sentence framing
  for the scoped domain. Deterministic fallback unchanged.

### API

- New `GET /api/twin-briefings/lifebook/:domain/latest?cadence=`
  returns `{ briefing: TwinBriefingRow | null }`. Null when no
  per-domain briefing exists yet — the common case while the
  worker hasn't run, the domain is too new, or it had zero events.

### Frontend

- `apps/web/public/js/pages/lifebook.js` fetches the per-domain
  briefing best-effort and renders it as a card. When no briefing
  exists yet, a friendly empty state explains when one will
  appear. Best-effort fetch — the rest of the page renders even
  if the briefing endpoint is unavailable.

### Test plan

3 new vitest cases in `briefing-generator.test.ts`:
- Per-Lifebook briefing written per visible lifebook with matching events.
- Lifebook with no matching events skipped (no empty rows).
- Per-lifebook failure doesn't take out the other lifebooks (resilience).

worker 86/86 (+3 new), api 547/547, db 189/189. Workspace: 70/70
turbo tasks green; build clean.

## [unreleased] — Provenance graph: filter by Lifebook wing (#193 follow-up)

Closes the **"provenance graph wing-filter consumer"** item that
PR #242 (#193 Child 1) explicitly deferred. The lifebook page has
been linking to `#/provenance?wing=<wingId>` since #242 shipped, but
the provenance page couldn't honor that filter because nodes had no
wing linkage. This PR adds the wing-id column + write-time
population + API filter + frontend consumer end-to-end.

### Migration

- `041-provenance-wing-id.sql` — adds nullable `wing_id UUID`
  column to `capability_provenance_nodes` plus a partial index
  `(user_id, wing_id, occurred_at DESC) WHERE wing_id IS NOT NULL`
  so per-wing graph queries are indexed without bloating the index
  with the long tail of NULL rows. No FK to lifebooks (would block
  lifebook hard-delete); the frontend filter naturally excludes
  NULL rows.

### Write-time population

- `provenanceRepository.writeNode()` auto-derives `wing_id` when
  the caller doesn't pass one explicitly: if the payload carries
  a `registryId`, look up the lifebook whose
  `suggested_capabilities` contains that id and stamp its
  `wing_id` on the node. Best-effort — a registryId not in any
  lifebook stays NULL. Explicit `wingId` argument always wins
  over auto-derivation, so future call sites with their own wing
  context can bypass the lookup.
- Older rows written before migration 041 stay NULL forever
  unless a future backfill utility runs.

### API

- `GET /api/capabilities/provenance-graph` now accepts an optional
  `wing=<uuid>` query param. UUID-validated (returns 400 on bad
  shape, same pattern as `serverId`). Each node in the response
  includes `wingId: string | null`.

### Frontend

- `provenance-graph.js` reads the `wing` param off the hash query
  string (the lifebook page's `#/provenance?wing=<uuid>` link),
  passes it through `fetchProvenanceGraph`, and renders a
  scoped-state indicator above the graph with a "Show all wings"
  button to clear the filter. UUID-validated client-side too so a
  malformed hash doesn't reach the API.

### Test plan

3 new vitest cases for the API surface (wing filter active,
invalid wing → 400, response includes `wingId` per node). Full
api suite: 547/547. Workspace: 70/70 turbo tasks green.

What this does NOT do: per-domain briefing prose (the other #193
deferred follow-up — separate PR), and backfill of `wing_id` for
existing provenance rows. The wing filter shows post-migration
nodes; older ones can be filled in by a follow-up utility if
usage demands it.

## [unreleased] — Capabilities: filter the registry by Lifebook (#193 follow-up)

### Fixed (post-Copilot review)

- Lifebook visibility filter now uses the correct API field
  (`hidden: boolean`) instead of the nonexistent `hiddenAt`. The
  previous filter was a no-op AND would have fail-opened if the
  endpoint ever returned hidden rows. The server-side `listVisible`
  call still does the real filtering; the client-side guard is
  defense in depth.
- Removed `data-action` from the category and Lifebook `<select>`
  elements. Each had an explicit `change` listener too, so the
  global click delegator double-fired `renderRegistryResults` on
  every dropdown-open. The change listener is now the sole entry
  point. Dead switch cases (`registry-filter-change`,
  `registry-category-change`) deleted.
- `applyLifebookFilter()` is now actually pure — lifebooks is the
  third argument with a default that pulls from cache only at the
  call site. The docstring's "pure function" claim no longer
  requires monkeypatching `_cachedLifebooks` to be true.

### Original change

Closes the "capability filter by domain on Capabilities page" item that
PR #242 (#193 Child 1) explicitly deferred. The Capabilities page now
carries a Lifebook dropdown alongside the existing category dropdown;
selecting a Lifebook intersects the registry results with that
Lifebook's `suggestedCapabilities: registryId[]` set so users browsing
for a specific life domain see only the capabilities the domain
extractor actually proposed for it.

**No DB migration required.** The filter is purely client-side: the
intersection set already lives on `lifebooks.suggested_capabilities`
(populated by the domain-extraction worker that landed in #242). The
capabilities page now fetches `/api/lifebooks/:userId` alongside its
existing data and runs the intersect in `applyLifebookFilter()` — a
pure helper that's trivial to lift to a vitest harness if/when one
lands in `apps/web`.

UX details:

- Dropdown shows visible (non-hidden) Lifebooks only. Hidden Lifebooks
  stay in memory but disappear from this dropdown, matching the
  "hidden surfaces stay queryable in memory; surface visibility is the
  user's call" contract Lifebooks already follow.
- When the user has zero Lifebooks (domain extractor hasn't run, or
  everything is hidden), the dropdown is omitted entirely — an empty
  selector with no options would just confuse.
- Empty-result state when a Lifebook filter narrows everything away
  surfaces the active Lifebook name in the empty-state copy ("No
  results found for the 'Health' Lifebook.") so the user can
  immediately tell *why* nothing's showing.
- A Lifebook with an empty `suggestedCapabilities: []` array means the
  extractor proposed nothing yet — the filter shows everything rather
  than collapsing to zero results, on the principle that "extractor
  hasn't decided" should not look the same as "extractor decided
  nothing matches."

Internal cleanup that fell out of the change:

- Three `renderRegistryResults(userId, q, category)` call sites
  collapsed to `renderRegistryResults(userId, readRegistryFilterState())`
  via a new `readRegistryFilterState()` helper. The helper reads the
  current dropdown/input values from the DOM (not pure, but isolated
  — one place to change when filters are added). Adding the Lifebook
  filter without this would have meant editing five separate call
  sites. The next filter to land gets to add itself in two places:
  the dropdown markup and the state reader.

Test plan: smoke-tested in Chrome with mocked Lifebook + registry data
— filter toggles correctly across three scenarios (all-Lifebooks, one
specific Lifebook, switch back to all). `node --check` clean.

## [unreleased] — Smart / Smarter mode toggle + zero-cost helper (#187 AC#6 + AC#8)

### Fixed (post-Copilot review)

- Cost rate table was off by 100× — the original draft stored
  `{ input: 8, output: 40 }` for Anthropic and called it "deci-cents
  per 1M" when the conversion is actually `$0.80 → 80¢ → 800
  deci-cents`. The table now stores `{ input: 800, output: 4000 }`
  for Anthropic and the corresponding corrected values for OpenAI and
  Google. The unit tests now pin the expected dollar-equivalent
  outputs ($4.80 for 1M+1M Anthropic, $0.60 for 1M output OpenAI,
  $0.30 for 1M output Google) so the unit conversion can't silently
  regress again. Embedded + Ollama still return 0¢ at any volume.
- `PUT /api/settings/:userId/ai` now accepts `embedded` as a valid
  provider. The Smart mode toggle inserts an `embedded` entry; the
  pre-existing validation set only allowed `anthropic` / `openai`
  / `google` / `ollama`, so clicking "Use Smart mode" round-tripped
  through `applySmartMode` and then 400'd at the API.
- `switchAIBrainMode` rolls back the optimistic UI state on save
  failure. Previously the pill + provider chain stayed in the
  reordered state with only an error banner — visually implying the
  switch succeeded when the server actually rejected it.
- "Smarter" pill copy now says "paid API or Ollama" — the
  `SMARTER_PROVIDERS` set includes Ollama (local, free) and the
  earlier copy would have confused users running Ollama into thinking
  the option didn't apply to them.

### Original change

Two pieces close out the user-visible side of the embedded LLM story:

- **AC#6 — Smart / Smarter mode toggle in the AI brain card.** A two-pill
  row at the top of Settings → AI brain shows the user which mode is
  active (computed from their provider chain: top-priority enabled =
  `embedded` → Smart; hosted / Ollama → Smarter; nothing enabled →
  none). Clicking the inactive pill reorders priorities and auto-saves
  through the existing `PUT /api/settings/:userId/ai` round-trip.
  Switching to Smart adds an `embedded` entry with `model: 'auto'` if
  the chain doesn't have one yet — first-time-Smart users get a working
  configuration in one click. Switching to Smarter when no paid
  provider exists routes to a `switch-to-smarter-blocked` action that
  focuses the "+ Add a provider…" dropdown so the user's eye is drawn
  to the next step instead of failing silently.

  Pure helpers (`detectAIMode`, `applySmartMode`, `applySmarterMode`)
  factored out at the top of `apps/web/public/js/pages/settings.js`
  with module exports so the mode pill, the action handler, and any
  future audit route all agree on one definition. 16 cases smoke-tested
  via Node ESM import; toggle visually verified in Chrome across three
  scenarios (Smart-active, Smarter-active, no-paid-provider).

- **AC#8 — `estimateLlmCostCents()` helper in `@skytwin/llm-client`.**
  Provider-keyed rate table (Anthropic / OpenAI / Google list-price
  cheapest model) plus an absolute zero for `embedded` and `ollama`.
  Rounds up to the nearest cent everywhere so spend-cap enforcement
  stays conservative — the failure direction is "approval required,"
  never "silently exceeded the cap." Exposed as
  `estimateLlmCostCents(provider, tokensIn, tokensOut)` and
  `isZeroCostProvider(provider)`. 10 unit tests; the load-bearing one
  asserts `embedded` and `ollama` return 0 regardless of token volume.
  The future spend-recording call site can compute
  `costCents = estimateLlmCostCents(response.provider, tokensIn,
  tokensOut)` and trust that local-runtime calls record zero — no
  embedded-special-case branch needed at the recording site.

## [unreleased] — Memory bootstrap: stamp every signal with an authoring tier (#251 Layer 1)

### Fixed (post-Copilot review)

- `listMessageIds()` no longer swallows all errors. Non-transient
  failures (persistent auth, 4xx other than 404, malformed account
  state) propagate so the worker surfaces "your Google connection has
  a problem" rather than silently bootstrapping zero signals forever.
  Only `RetryableHttpError` (rate-limit / 5xx after retries) still
  degrades to `[]` so one transient list failure doesn't take out the
  other batch.
- `AUTOMATED_DOMAIN_PATTERNS` doc comment now accurately describes
  the deliberate asymmetry: most entries are end-anchored at the
  apex domain (`$`), but `noreply\.` is intentionally NOT end-
  anchored so the `noreply.<vendor>.com` long tail is caught.

### Original change

The first slice of #251. Layer 1 only labels the data — no retrieval-side
weighting yet (that's Layer 2, gated on `realistic-retrieval.test.ts`
improving) — so this PR is reversible and observable on its own.

- **New: `AuthoringTier` enum + classifier in `@skytwin/connectors`.**
  Six tiers (`user_sent_originated`, `user_sent_reply`, `inbox_personal`,
  `inbox_broadcast`, `inbox_newsletter`, `inbox_automated`) capturing the
  asymmetry between mail the user authored vs. merely received. The field
  name is channel-agnostic on purpose (`authoringTier`, not
  `gmailLabel`/`senderTier`); Slack/Notion connectors can extend the enum
  later without rebuilding the memory schema.

- **Gmail connector fetches the headers needed to classify.** Added
  `To`, `Cc`, `In-Reply-To`, `List-Unsubscribe` to the
  `metadataHeaders=` URL on `messages/<id>?format=metadata`. One extra
  HTTP-header byte per message; the rest of the payload is unchanged.
  Every emitted `RawSignal` carries `data.authoringTier`.

- **Embedded gbrain port projects `authoringTier` onto
  `brain_pages.metadata`.** When a connector stamps the field, the page
  metadata gets `{ signalSource, signalType, authoringTier }`; when the
  field is missing or non-string the page metadata falls back to the
  previous two-key shape. No schema migration — `metadata` is JSONB.

- **Layer 3 minimal: sent-first bootstrap ordering.** The first poll
  for a new user now lists `in:sent newer_than:7d` BEFORE
  `is:unread newer_than:1d` and deduplicates by message id. The user's
  first brain pages lead with things they wrote, not the inbox noise that
  happens to be unread. Failure on either list query degrades gracefully
  to the other; both empty falls back to `/users/me/profile` for the
  cursor exactly as before.

Tests: 18 new unit tests for the classifier (`authoring-tier.test.ts`),
6 new tests for the Gmail signal pipeline (tier stamping for each of the
six tiers), 1 new test for sent-first bootstrap ordering, and 3 new tests
for the embedded-port metadata projection. Full workspace test run:
70 tasks, all green.

What this doesn't ship (deliberate, deferred to follow-ups):

- **Layer 2 retrieval weighting.** The RRF fold and `DecisionMaker`
  pattern boost still read `brain_pages` uniformly. Wiring those to the
  new tier requires re-running `realistic-retrieval.test.ts` with
  candidate weight schedules and accepting whichever schedule moves R@5
  up (or holds it constant) on the labeled corpus. That gate is the
  whole point of Layer 2 being a separate PR.
- **Migration backfilling tier on existing pages.** Tier is only stamped
  on signals written after this lands. A backfill migration is cheap to
  write (re-read the Gmail label + From header for stored signal rows)
  but is a separate concern from the live ingest path.
## [unreleased] — Embedded LLM downloader: round-3 review fixes (#187 AC#2 follow-up)

Copilot's third-round review of PR #247 landed after merge — four
substantive findings, addressed in a follow-up PR:

- **Multi-user partial-file collision**: two users on the same API
  host downloading the same model both wrote to
  `<modelDir>/<modelId>.gguf.partial`, so concurrent streams could
  corrupt each other and one user's cancel could delete the other's
  partial. The final GGUF is content-addressable (SHA-256 verified
  before rename), so we keep that shared at `<modelDir>/<modelId>.gguf`,
  but partials now namespace by download row id:
  `<modelDir>/<modelId>.gguf.<download.id>.partial`.

- **Pause-on-pending was a no-op**: `pauseDownload()` would set DB to
  `paused`, but the already-scheduled `runDownload()` invocation
  would start anyway and immediately overwrite back to `downloading`
  via `setStatus`. Same bug for pending→cancelled. Fixed by
  re-fetching the row at the top of `runDownload()` and bailing
  early if status changed to `paused`/`cancelled`/`complete`/`failed`
  between `startDownload()` returning and the runner picking up.

- **Polling continued after navigating away**: the 1s poll callback
  in `embedded-llm-card.js` had no termination condition tied to
  page navigation. A user who started a download and then went to
  Approvals would keep hitting `/api/embedded-llm/downloads/:id`
  every second and hold a reference to a detached
  `#embedded-llm-card-target` node. Now the poll callback checks
  `window.location.hash !== '#/settings'` and
  `document.getElementById(CARD_TARGET_ID) !== container` at the
  top and stops itself when either is true.

## [unreleased] — First-run dashboard "needs a brain" prompt (#187 follow-up)

A tiny but launch-critical UX gap: a brand-new user lands on the dashboard
with no AI provider configured and an empty state that offers no path
forward. They're left to discover Settings → AI brain on their own.

Closes the gap with a banner that surfaces only when (a) the dashboard
fetch promises resolved successfully (no false-positive on transient API
errors), (b) zero decisions exist yet, AND (c) zero AI providers are
enabled. The provider check matches the Settings UI's truthiness rule
(`p.enabled !== false`), so existing rows without an explicit `enabled`
field aren't misread as off.

Two CTAs: "Set up the local brain" (routes to Settings → Local AI brain
card from #187 AC#2) and "Or bring your own API key". Privacy framing
is per-option (not global): the local-first claim is scoped to the
local brain row; the API-key row clearly notes "each message goes to
that provider." Skipped in tour mode (seeded demo user has providers
pre-configured), so the demo experience stays clean.

Settings is fetched conditionally — only when the cheap prerequisites
(`!tourMode && recentDecisions.length === 0`) already point at first-run.
Once the user has any activity, no extra `/api/settings` round-trip per
SSE-driven dashboard re-render.

Implementation lives in `apps/web/public/js/pages/dashboard.js`. Reuses
the existing `GET /api/settings/:userId` endpoint via `fetchSettings` —
no new API. One new card, no other UI changes.

## [unreleased] — gbrain memory backend + CRDB adapter + hybrid composer (#197)

Closes the major remaining work on #197 by promoting `@skytwin/memory-gbrain`
from a CLI-shell-out skeleton (PR #215) to a real, in-process, CockroachDB-backed
memory layer. The default `MemoryPort` for new installs is now gbrain — vector
embeddings + tsvector full-text search, fused via Reciprocal Rank Fusion. No
separate Postgres process, no external CLI install — gbrain runs against the
SkyTwin DB stack directly.

### Why this matters

The mempalace search story today is `ILIKE %term%` over `memory_drawers.content`.
Works for hundreds of drawers per user; doesn't work at the size we want twins
to operate at. Gbrain's hybrid retrieval engine is what mempalace was a sketch
of: indexed semantic + keyword fusion that scales to tens of thousands of pages
per user with sub-100ms search latency on the in-process backend.

User direction was explicit: gbrain is the **default**, mempalace is the
**second option**, and everything must work against CRDB where possible. Done.

### Ships

- **`040-gbrain-memory.sql`** — new tables: `brain_pages` (FLOAT8[] embedding
  + TSVECTOR + INVERTED INDEX), `brain_entities`, `brain_triples`,
  `brain_episodes`, `brain_signals`, `brain_settings`, `brain_embedding_jobs`
  (durable queue with `SELECT FOR UPDATE SKIP LOCKED` lease semantics).
- **`@skytwin/memory-gbrain-crdb-adapter`** (NEW) — driver-level layer:
  - `repository.ts` — CRDB-backed CRUD + `hybridSearch` (parallel text + vector
    queries, application-side RRF fold).
  - `in-memory-repository.ts` — same surface, in-process; used by tests and
    hermetic boots.
  - `embedding.ts` — `EmbeddingProvider` interface + two impls:
    `HashEmbeddingProvider` (deterministic, hash-trick, zero-config) and
    `OpenAiEmbeddingProvider` (any OpenAI-compatible /v1/embeddings endpoint —
    works with Ollama, llamafile, vLLM).
  - `rrf.ts` — Reciprocal Rank Fusion fold (k=60 standard).
- **`@skytwin/memory-gbrain`** — promoted from skeleton:
  - `EmbeddedGbrainMemoryPort` — full `MemoryPort` impl. Capabilities:
    `semantic_search`, `code_aware_search`, `temporal_triples`, `episodic`,
    `graph_walk`. Synchronous embedding when fast (hash); async via the
    embedding job queue when an external provider is configured.
  - `searchCodeAware` — boosts pages with `source = 'code'` 1.25×.
  - `hasExternalGbrainConfig()` — detects existing `~/.config/gbrain/` so the
    dashboard can surface the hybrid-mode opt-in prompt.
- **`@skytwin/memory-hybrid`** — diagnostics-aware composer:
  - `HybridDiagnostics` counters expose routing + write outcomes.
  - `resolveReadPort` falls through to the secondary when the primary lacks the
    relevant capability (instead of silently returning empty).
- **`apps/api/src/memory-setup.ts`** — per-user backend factory:
  - Default `gbrain`; `MEMORY_BACKEND` env override; per-user `brain_settings`
    override beats env.
  - Embedding provider selection: OpenAI when key present, hash fallback.
- **`apps/api/src/routes/memory-config.ts`** — new REST surface:
  `GET / POST /api/memory-config`, `POST /dismiss-notification`,
  `GET /diagnostics`. Mounted under `sessionAuth + requireOwnership`.
- **`apps/web/public/js/pages/memory-settings.js`** — settings page
  (`#/memory-settings`): backend switcher, capability list, page index counts,
  hybrid diagnostics, "Your twin just got smarter" first-run notice with
  dismiss action. Singleton click delegator gated on `window.location.hash`
  per CLAUDE.md frontend event-handling discipline.
- **`docs/memory-swap.md`** — backends-at-a-glance, env knobs, migration
  recipe, rollback path.

### Tests

- `@skytwin/memory-gbrain-crdb-adapter`: 49 unit (embedding 25, rrf 6, in-memory
  repo 18) + 6 DB-gated integration (skipped unless `RUN_DB_TESTS=1`).
- `@skytwin/memory-gbrain`: 50 (cli-detector 10, gbrain-port 20,
  embedded-port 20, integration 5) + 1 always-on quality benchmark + 1
  opt-in perf benchmark gated on `GBRAIN_PERF=1`.
- `@skytwin/memory-hybrid`: 19 (10 existing + 9 new diagnostics).
- `@skytwin/api`: +21 (13 memory-setup unit + 8 memory-config-routes E2E).
- Total: 145+ new tests; full suite: 70/70 turbo tasks pass.

### Operational notes

- Set `MEMORY_BACKEND=gbrain` (default) or `hybrid` or `mempalace` to switch the
  per-installation default; per-user override via the dashboard.
- Set `OPENAI_EMBEDDING_API_KEY` (or `OPENAI_API_KEY`) to switch from the
  hash-trick fallback to real embeddings. `OPENAI_EMBEDDING_BASE_URL` lets you
  point at any OpenAI-compatible endpoint (Ollama, llamafile, vLLM, …).
- Rollback: `MEMORY_BACKEND=mempalace`. The legacy `/api/mempalace` REST surface
  still works regardless — it queries `memory_*` tables directly, not via
  `MemoryPort`.

## [unreleased] — Embedded LLM model downloader (#187 AC#2)

Closes AC#2 of #187. The single piece between "developer tool" and
"consumer app": a fresh install can now fetch its own model with no
config, no API keys, no per-message cost. The registry shipped in #246
told us *which* model to download; this PR makes it actually happen,
with pause / resume / cancel and persistence across API restarts.

### Why this is the launch-gating piece

A non-technical user opening SkyTwin previously hit a wall: the twin
needed an LLM, but configuring one meant either installing llama.cpp
manually + downloading a GGUF + setting `SKYTWIN_LLAMA_MODELS`, or
buying API keys from Anthropic/OpenAI. Now: open Settings → "Local AI
brain" card detects the user's RAM bracket via `navigator.deviceMemory`,
recommends the highest-quality model that fits, click Download → 3-15
minutes later the twin works fully offline.

### Ships

- `039-model-downloads.sql`: `model_downloads` table tracking each
  download — model_id, target_path, total_bytes, bytes_downloaded,
  sha256_expected, status (pending → downloading → verifying →
  installing → complete; or paused / failed / cancelled), started_at,
  paused_at, completed_at.
- `modelDownloadRepository`: create, findById, listForUser, findActive
  (idempotency on user+model), updateProgress (chunk-tick), setStatus
  (with paused_at / completed_at side effects), `recoverOrphanedDownloads`
  (boot-time recovery — orphaned `downloading` rows flip to `paused`).
- `apps/api/src/embedded-llm/downloader.ts`: the download engine.
  - Streams `fetch()` body to `<target_path>.partial`, atomic rename
    on success.
  - Resume via HTTP `Range` header — server that ignores Range falls
    back to full re-download (rare; logged).
  - Progress flushed to DB every ~1MB to keep transactions cheap.
  - SHA-256 verification post-download (skipped when registry hash is
    placeholder all-zeros — v1 hashes are stubs pending real artifact
    measurement).
  - In-flight `AbortController` map for pause/cancel.
  - Default model dir: `~/.skytwin/models/llama` if `SKYTWIN_LLAMA_MODELS`
    unset (matches the runtime detector's read path).
- `apps/api/src/routes/embedded-llm.ts`: extended with downloader
  endpoints (start, get, list-for-user, pause, resume, cancel,
  model-dir). Idempotent on `(userId, modelId)` so spam-clicking
  Download doesn't spawn duplicate transfers.
- Boot-time recovery wired into `apps/api/src/index.ts` —
  `recoverOnBoot()` runs alongside execution-router init.
- `apps/web/public/js/components/embedded-llm-card.js`: Settings card.
  Detects RAM bracket, recommends a default, shows a select for
  override, renders the download in progress with progress bar (reuses
  existing `.confidence-bar` styles), pause/resume/cancel buttons,
  error surface. Polls `/downloads/:id` every 1s while a download is
  active; stops polling on terminal status.
- 25 unit tests for the route layer in
  `apps/api/src/__tests__/embedded-llm-downloads-routes.test.ts`:
  start happy + missing-userId/modelId + 404 unknown-model, get +
  404, percent capping at 100% for over-fetch, percent=0 for pending,
  list-for-user, pause ok/false, pause-404, resume + 404, cancel,
  cancel-404, plus 7 cross-user-403 tests covering every mutating
  endpoint plus the dev-bypass-allowed case. Mocks `@skytwin/db` +
  the downloader module — no real HTTP / filesystem.

API total: 486 passing (24 skipped). All 34 packages build clean.

### Fixed (post-/review)

Copilot review on PR #247 surfaced 12 substantive findings; all
addressed before merge:

- **IDOR on `POST /downloads/start`**: applied `requireOwnership`
  middleware so the request body's `userId` must match the
  authenticated user.
- **IDOR on `GET /downloads/:id` and the pause/resume/cancel routes**:
  introduced a `loadOwnedDownload(req, res, id)` helper that fetches
  the row and rejects with 403 if `req.authenticatedUserId` doesn't
  match `row.user_id`. Dev bypass (no `authenticatedUserId`) keeps
  current behavior.
- **OOM on multi-GB SHA-256 verify**: replaced `readFile(path)` with a
  streaming `createReadStream → hash.update(chunk)` loop in a new
  `computeSha256(path)` helper. A 4GB GGUF no longer needs 4GB of
  Node heap to verify.
- **DB-level idempotency**: schema changed from a non-unique partial
  index to a `UNIQUE` partial index on `(user_id, model_id)` for
  non-terminal statuses, so two concurrent `/downloads/start` calls
  can't both win past `findActive()`. `startDownload()` now also
  catches the `23505` unique-violation that the loser's `INSERT`
  raises and re-fetches the surviving row.
- **In-memory race**: `startDownload()` now bails if the row is
  already in `inFlight`, preventing two concurrent runners writing
  the same `.partial`.
- **Stale progress on Range-ignored**: when the server returns 200 to
  a Range request, we now `updateProgress(id, 0)` immediately so the
  poll UI doesn't display stale `bytes_downloaded` until the next
  1MB flush.
- **`total_bytes` never persisted**: added
  `modelDownloadRepository.updateTotalBytes(id, n)` and call it when
  Content-Length disagrees with the registry by >1MB. The progress
  bar denominator now matches reality.
- **DOM update broke action buttons**: the polling tick was finding
  `labelLine.firstElementChild` and replacing it, which clobbered
  the size/percent span on first run and the action-button span on
  subsequent runs. Switched to stable `data-role` selectors
  (`embedded-llm-progress-text`, `embedded-llm-status`) so updates
  are scoped.
- **Singleton listener stale closure**: `ensureListener()` no longer
  closes over `container` or `userId` from the first mount. The
  delegator now re-derives both at click time:
  `document.getElementById('embedded-llm-card-target')` for the
  container, `localStorage.getItem(KEY_USER_ID)` for the userId.
  Same pattern as the other singleton delegators in this codebase.
- **Test auth pattern**: switched from injecting `req.user.id` to
  `req.authenticatedUserId` to match production. Added 7 new tests
  covering cross-user 403 on every mutating endpoint plus the
  dev-bypass-allowed path.

### Why this fits the theme

This is "boring deterministic" infrastructure — `fetch()` with `Range`,
SHA-256 verify, atomic rename. No LLM in the cryptography or the
download path. Every byte is accounted for; every state transition is
reflected in the row; every user-facing button has a deterministic
back-end consequence. The adaptive layer (the prompts that consume the
model once installed) doesn't change at all.

### Out of scope

- **Real SHA-256 hashes in the registry**: the v1 registry ships with
  all-zero placeholder hashes. The downloader detects this and skips
  verification. Filling in real hashes is a one-line change per model
  once an artifact has been measured (download once, `shasum -a 256`,
  paste). Tracking as a follow-up.
- **First-run onboarding integration**: the card lives in Settings
  today. The natural follow-up is to surface it as the first card on
  the dashboard when no model is installed AND no LLM provider is
  configured — making "your twin is downloading its brain" the
  explicit first-run state. Small change to `dashboard.js`.
- **Resume after API restart with a UI prompt**: orphaned downloads
  flip to `paused` on boot; the user sees a "Paused" download with a
  Resume button on next Settings visit, which is the desired UX. A
  toast / banner alerting them proactively is a small follow-up.

## [unreleased] — Accessibility: high-contrast + text-scale + voice STT route (#194 Child 4)

Closes the a11y commitments of #194 Child 4. Detailed entry in PR #244.

## [unreleased] — Crisis modes: recovery codes + vacation mode (#194 Child 3 partial)

Closes 2 of 4 sub-features in #194 Child 3: recovery codes + vacation mode. Detailed entry in PR #245.

## [unreleased] — Federation pairing protocol + delta sync (#194 Child 1)

Closes Child 1 of #194: real federation between a single user's instances
(desktop ↔ phone ↔ home server). NaCl-box pairing handshake, hourly
delta-sync worker, Settings UI for the pair / unpair / list flow. End-
to-end encrypted between paired peers; OAuth tokens excluded from sync.

Detailed entry preserved separately on the federation branch — kept terse
here to resolve the rebase against #193 cleanly.

## [unreleased] — Emergent Lifebooks Child 1: domain extractor + dynamic wings + dashboard surface (#193)

The OSS-launch headline made executable. Closes Child 1 of #193 in two
slices delivered as one PR.

The naive approach to "life management" hardcodes a fixed taxonomy
(Health, Money, Relationships, …) with curated capability bundles per
vertical. Wrong: it assumes every user's life decomposes the same way.
What about Kayaking? Aging Parents? Caregiving? Job Search?

The right approach: emergent verticals. The twin reads the user's
MemPalace, names the life domains *that user actually operates in*,
creates a wing per domain, and surfaces them on the dashboard. No
hardcoded list. Adding a new "kind" of Lifebook doesn't need a code
deploy — just a better domain-extraction prompt.

### Ships

#### Slice 1 — domain extractor worker (#193 Child 1, AC#1-#3)

- `packages/db/src/migrations/036-lifebooks.sql` — `lifebooks` table
  with `(user_id, domain_name)` unique key, importance enum (core /
  secondary / emerging), JSONB sample_signals + suggested_capabilities,
  optional wing_id pointer, soft-hide via `hidden_at`. Two indices:
  visible-only (for dashboard) and all (for management UX).
- `packages/db/src/repositories/lifebook-repository.ts` — `upsert`
  (idempotent on `(user_id, domain_name)`, never resurrects hidden rows
  on re-extraction), `listVisible`, `listAll`, `findByDomain`, `hide`,
  `unhide`. SQL-direct, parameterized, no ORM.
- `apps/worker/src/jobs/domain-extraction.ts` — `runDomainExtractionJob`
  walks active users (anyone with installed servers OR populated wings),
  builds a memory_summary from `knowledge_entities` + `knowledge_triples`
  (top 40 of each), runs `runPrompt('domain-extraction')`, validates the
  array output, and per-domain calls `mempalaceRepository.getWingByName`
  → `createWing` (with idempotent get-or-create) → `lifebookRepository.upsert`.
  Wired into `apps/worker/src/index.ts` poll loop on a 7-day cadence.
  Per-domain persist failures don't abort the user-loop; per-user errors
  don't abort the job. No-ops if no LlmClient is available — extraction
  is LLM-dependent.
- `apps/worker/src/__tests__/domain-extraction.test.ts` — 12 unit tests:
  empty-memory short-circuit, missing-LLM short-circuit, persist-each-
  domain happy path, reuse-existing-wing, invalid-entry filtering, non-
  array output handling, domain-cap-at-10, per-domain failure resilience,
  job-level user-loop, no-active-users skip. Mocks all of `@skytwin/db`,
  `@skytwin/policy-prompts` so tests never spawn DB or LLM.

#### Slice 2 — dashboard surface + per-Lifebook UX (#193 Child 1, AC#4-#7)

- `apps/api/src/routes/lifebooks.ts` — `GET /api/lifebooks/:userId`,
  `GET /api/lifebooks/:userId/all`, `GET /api/lifebooks/:userId/:domainName`
  (returns lifebook + wing room/drawer counts), `POST .../:domainName/hide`,
  `POST .../:domainName/unhide`. Mounted under `requireOwnership` so
  cross-user reads are blocked at the middleware layer. Worker is the
  only writer of *content*; this router only adjusts visibility.
- `apps/web/public/js/api-client.js` — `fetchLifebooks`, `fetchLifebook`,
  `hideLifebook`, `unhideLifebook` helpers.
- `apps/web/public/js/pages/dashboard.js` — "Your Lifebooks" card.
  Shows top 5 detected domains with importance badges, each linking to
  `#/lifebook/<domain>`. Renders nothing when no lifebooks exist (silent
  rather than a confusing "no domains detected" placeholder for users
  who haven't yet had the worker run).
- `apps/web/public/js/pages/lifebook.js` — per-Lifebook page at
  `#/lifebook/<domain>`: importance badge, sample signals, suggested
  capabilities, wing summary, and "Hide from dashboard" button. Singleton
  delegator gated by hash route — same pattern the rest of the SPA uses.
- `apps/web/public/js/app.js` — registers the dynamic
  `/lifebook/<domain>` route with title decoded from the path segment.

### Why this fits the theme

This slice is the architectural philosophy made executable:

- **Hard rails preserved**: lifebook visibility is the only user-driven
  write; domains *cannot* be added by hand. They emerge from memory.
- **Boring deterministic**: wings, rooms, drawers — same `KnowledgeEntity`
  + wing/room/drawer schema MemPalace already provides. No new
  vertical-specific tables. The lifebooks table is a thin index pointing
  at existing memory.
- **Adaptive**: domain naming, importance scoring, capability suggestions
  all flow through `@skytwin/policy-prompts` (`domain-extraction` v1).
  Adding a new "kind" of Lifebook is a prompt edit, not a code deploy.
- **Memory port**: the worker's read path is the existing MemPalace
  query; the write path goes through `Palace.ensureWing` (idempotent).
  Future MemoryPort backends (gbrain in #197) will plug in without
  touching this worker.

### Out of scope (explicitly deferred)

- Per-Lifebook briefing prose (#193 Child 1 AC#4 second half) — the
  briefing-generator (#177) is unchanged. Per-domain briefings are a
  natural follow-up but require schema changes to `twin_briefings`
  that aren't worth bundling here.
- Capability filtering "by domain" on the existing Capabilities page —
  the suggested categories are stored on the lifebook row but the
  Capabilities page itself is unchanged. Cross-link is a follow-up.
- Provenance graph filtering by wing (deep-link from Lifebook page).
  The href is wired but the graph page doesn't yet read the `wing`
  query param. Tracking as a separate small UX issue.

### Why NaCl box, not just HMAC (federation context)

Federation deltas include trust-tier, risk-profile, and recent decision
metadata. Confidentiality matters for a peer on a coffee-shop LAN — HMAC
alone (integrity, no confidentiality) wouldn't be enough. NaCl box
(Curve25519 + XSalsa20 + Poly1305) gives us asymmetric encrypt-and-
authenticate in one primitive with a 32-byte key per side. Implemented
via `tweetnacl` (audited pure-JS port, ~50KB unzipped, no native deps).

### Ships

- `037-federation-peers.sql` — `federation_peers` (+ soft-delete via
  `unpaired_at`) and `federation_pairing_codes` (10-min TTL slots).
- `federation-peer-repository.ts` — typed CRUD + `markSyncResult`.
  `create` is upsert-by-(user_id, peer_public_key) so re-pairing same
  peer updates rather than duplicates.
- `apps/api/src/federation/crypto.ts` — `generateKeyPair`,
  `generatePairingCode` (CSPRNG-backed via `node:crypto.randomInt`),
  validators, `sealMessage`/`openMessage`. Pure JS, no native deps.
- `apps/api/src/routes/federation.ts` — `/pair/start` (initiator),
  `/pair/complete` (joiner; cross-user code redemption returns 403
  for distinct audit trail), `GET /peers/:userId`, `POST .../unpair`.
- `apps/worker/src/jobs/federation-sync.ts` — hourly job that walks
  active peers with `endpoint_url`, builds a `DeltaPayload` (active
  MCP servers + last 100 capability_provenance edges; **excludes**
  OAuth tokens, vault secrets, encryption keys), seals via `nacl.box`,
  POSTs to `<endpoint>/api/federation/inbox`. Per-peer failures don't
  abort the loop.
- `apps/web/public/js/pages/settings.js` — "Linked devices" card with
  pair / "I have a code" / unpair UX. `apps/web/public/js/api-client.js`
  exports the four federation helpers.

### Tests

- `federation-crypto.test.ts` (13): keypair shape + freshness, code
  format, key validation, seal/open round-trip, wrong-sender, tampered
  ciphertext, wrong nonce.
- `federation-routes.test.ts` (11): start success + missing-userId,
  complete happy + 5 reject cases (malformed code/key/label, expired,
  cross-user 403, malformed endpoint), list (shape + secret-key never
  leaked), unpair true/false.
- `federation-sync.test.ts` (9): payload filtering (active-only,
  null registry_id skip, edges included), seal round-trip, push
  success, non-2xx failure, network error per-peer continuation,
  passive peer skip, trailing-slash endpoint normalization.

API total: 439 passing. Worker: 59 passing.

### Out of scope

- `/api/federation/inbox` receive route. Worker pushes today; receivers
  accept-and-merge in the next PR. Two paired devices are aware of each
  other but deltas land at 404 — the worker records the failed status
  with `last_sync_error: "peer responded 404"` so diagnostics still
  work before the receiver lands.
- AC#5 cross-backend `MemoryPort` exportAll/importAll wiring. Substrate
  is in place; integration into federation-sync is mechanical follow-up.
- AC#6 manual-resolve UI for installed-server conflicts.

### Why server-mediated pairing, not P2P over LAN

Direct LAN pairing needs mDNS + NAT-traversal — substantial complexity
v1 doesn't need. MVP pairs through the central API: instance A generates
code, the API holds the ephemeral keypair, instance B redeems on the
same API, both sides commit a peer row. After pairing, each instance's
worker pushes deltas via `endpoint_url`. Users with a single
internet-facing instance keep "passive peers" (no endpoint_url) that
benefit from inbound deltas without needing to be reachable.

## [unreleased] — Embedded LLM as a first-class llm-client provider (#187 AC#7)

Closes AC#7 of #187: "Same `@skytwin/policy-prompts` prompts work
against embedded model AND hosted models." Adds `'embedded'` as a
fifth `AIProviderName` alongside the existing four (anthropic, openai,
google, ollama). Callers of `LlmClient.generate()` now get embedded
inference transparently when `embedded` is in their provider chain —
no separate code path, no separate prompt format. Same circuit
breaker, same fallback chain, same streaming wrapper. Local
inference becomes one entry in the user's chain instead of a parallel
universe the rest of the codebase has to know about.

### Ships

- `packages/shared-types/src/ai-provider.ts` — `AIProviderName` extended
  with `'embedded'`. `PROVIDER_MODELS.embedded` lists `'auto'` (the
  factory's default model resolution). `PROVIDER_INFO.embedded` carries
  user-facing label/description plus `requiresApiKey: false`,
  `requiresBaseUrl: false`.
- `packages/llm-client/src/providers/embedded.ts` — provider function
  that wraps `createEmbeddedTextPort()`. Renders `ChatMessage[]` to the
  `role: content` block format `llama-cli -p` consumes (`system: ...`
  → `user: ...` → `assistant:` trailing prompt). Inline `system`
  messages take precedence over `options.systemPrompt`, matching the
  OpenAI / Ollama providers. Caches the port instance per
  resolved-model-key so detection runs once per model. Exports
  `_clearEmbeddedPortCache()` for test isolation.
- `packages/llm-client/src/llm-client.ts` — `embedded` registered in
  `PROVIDER_FNS` and `PROVIDER_STREAM_FNS` (via `makeFallbackStream`,
  the same path Ollama uses today). No structural changes to the
  client; the new provider just slots into the existing chain.
- `packages/llm-client/package.json` — declares
  `@skytwin/embedded-llm: workspace:*`.
- `apps/web/public/js/pages/settings.js` — adds `embedded` to the
  `Settings → AI brain` provider picker dropdown plus its
  `PROVIDER_MODELS` and `PROVIDER_LABELS` maps.
- `packages/llm-client/src/__tests__/embedded-provider.test.ts` —
  11 unit tests: trims output, passes maxTokens/temperature,
  renders multi-turn ChatMessage[] with assistant trailer, inline
  vs options system precedence, explicit modelPath vs auto, port
  caching across calls, separate cache entries per model, error
  propagation, ignored apiKey/baseUrl. Mocks `@skytwin/embedded-llm`
  via `vi.mock` so tests never touch the real subprocess. Total
  package now: 126 tests passing.

### How callers use it

```ts
import { LlmClient } from '@skytwin/llm-client';

const client = new LlmClient(userId, [
  { provider: 'anthropic', apiKey: '...', model: 'claude-...' },
  { provider: 'embedded', apiKey: '', model: 'auto' },        // local fallback
]);

// Identical call site whether the chain runs hosted or embedded.
const { content } = await client.generate(prompt, { maxTokens: 256 });
```

### Out of scope

- Streaming with token-level granularity from llama-cli — wrapped via
  `makeFallbackStream` for now (single chunk on completion).
- Cost dashboard zero-cost rendering for `embedded` provider — small
  UI tweak in the cost panel; tracked as follow-up under #187 AC#8.

## [unreleased] — Auto-launch toggle UI + DXT drag-drop entry point (#191 + #180)

Closes the auto-launch UX for #191 and the DXT drag-drop entry point for
#180. The IPC handlers `get-launch-at-login` / `set-launch-at-login`
landed in #218 with no UI; this PR puts a real toggle in Settings → Desktop
and wires the `app.setLoginItemSettings` round-trip end-to-end.

For #180, the existing DXT import flow (#219 export, #224 install confirm)
had no entry point — users could only POST a `.dxt` file via curl. This
PR adds two real entry points: body-wide drag-drop in the renderer and an
OS file-association handler in the main process.

### Ships

- `apps/web/public/js/pages/settings.js` — new "Desktop" card visible
  only when `window.skytwinDesktop?.isDesktop`. Toggle switch wired to
  `setLaunchAtLogin(boolean)`; hydrates from `getLaunchAtLogin()` on
  render. Toast on save success / failure; on failure the toggle reverts
  to its previous state.
- `apps/desktop/src/main.ts` — `read-dxt-file` IPC handler (`.dxt` or
  `.json` path → `{ name, base64 }`); `app.on('open-file', ...)` handler
  that buffers the path and forwards it to the renderer once the
  webContents finish loading. Pending-path drain on `did-finish-load`
  covers the case where the user double-clicks a `.dxt` before the window
  is ready.
- `apps/desktop/src/preload.ts` — exposes `readDxtFile(filePath)` and
  `onDxtFileOpened(listener)` (returns unsubscribe fn).
- `apps/web/public/js/app.js` — `wireDxtDropAndOpen()` runs once on
  `DOMContentLoaded`. Document-level `dragover`/`drop` handlers filter
  for `.dxt`/`.json` files (via `DataTransfer.types.includes('Files')`
  + filename check), read via `FileReader.readAsDataURL`, POST to
  `/api/dxt/import` with the base64 blob, and navigate to `#/dxt/imports`
  on success. Subscribes to `skytwinDesktop.onDxtFileOpened` for the
  Finder/Explorer double-click path — same import flow, file is read via
  the IPC handler instead of FileReader. Toast feedback on every code
  path. Multi-file drops produce a "drop one at a time" toast rather than
  silently picking the first.

### Why drag-drop runs in the renderer, not the main process

Browser file drops carry the `File` object directly — we already have the
bytes without touching disk. The OS-passed path from `app.on('open-file')`
is the only case where the renderer doesn't have bytes; that's why the
`readDxtFile` IPC exists as a narrow allowlist (`.dxt`/`.json` only,
explicit filePath argument). Keeping the body-wide drag-drop in the
renderer also means it works in the pure-web build of the dashboard where
no `skytwinDesktop` exists.

### Out of scope

- File-association registration in `electron-builder` config (the OS won't
  fire `open-file` for `.dxt` until macOS Info.plist `CFBundleDocumentTypes`
  / Windows registry associations are declared at install time — that's a
  packaging concern, not a runtime one).

## [unreleased] — Desktop idle bridge via Electron powerMonitor (#180 partial)

Closes one of the four "desktop integration" sub-asks of #180: a real
OS-level idle bridge in the Electron main process. Wires Electron's
`powerMonitor` (lock-screen, unlock-screen, suspend, resume + a polled
`getSystemIdleTime()` check) into a single `onStateChange(state, reason)`
callback that the renderer subscribes to via the `skytwinDesktop` preload
API. This gives the web dashboard a real signal it can use to fire a
proactive scan when the user steps away — not a `setInterval` heartbeat
that fires whether the user is at the keyboard or not.

### Ships

- `apps/desktop/src/idle-bridge.ts` — `IdleBridge` class. Listens to
  `powerMonitor.on('lock-screen' | 'unlock-screen' | 'suspend' | 'resume')`
  and runs a polled `getSystemIdleTime()` check at a configurable interval
  (default 30s) against a configurable threshold (default 300s = 5min).
  Internal state machine debounces transitions so the callback fires
  exactly once per idle ↔ active flip — no flapping at the threshold.
  Handler exceptions are isolated so a renderer crash can't tear down
  the bridge.
- `apps/desktop/src/main.ts` — constructs `IdleBridge` after services
  start, wires it to `mainWindow.webContents.send('idle-state-changed', ...)`,
  and stops it on `before-quit`.
- `apps/desktop/src/preload.ts` — exposes `skytwinDesktop.onIdleStateChanged(listener)`
  via contextBridge. Returns an unsubscribe function.
- `apps/desktop/src/__tests__/idle-bridge.test.ts` — 13 unit tests
  covering threshold transitions, debouncing, lock/unlock, suspend/resume,
  same-state no-op, handler isolation, idempotent start/stop, listener
  cleanup on stop, and the no-op fallback when powerMonitor is absent.
  Injectable `PowerMonitorLike` fake — tests never touch real Electron.

### Why this is distinct from `@skytwin/idle-miner.ElectronIdleDetector`

The existing detector lives inside the worker package and powers
filesystem mining at idle. The desktop "idle bridge" is the renderer-facing
integration — it surfaces the same OS signal to the web dashboard via
IPC so consumers can fire proactive scans, pause expensive work when
the screen locks, etc. Both read `powerMonitor` independently with
their own debouncing and thresholds tuned to their use cases.

## [unreleased] — Real llama.cpp + whisper.cpp backends for embedded LLM (#187 partial)

Replaces the `Null*Port` stubs in `@skytwin/embedded-llm` with real subprocess
backends. PR #221 shipped the port interfaces and runtime detector; this PR
ships the actual implementations that spawn the binaries and parse output.

Validated end-to-end against `/opt/homebrew/bin/llama-cli` (Homebrew llama.cpp)
and `/opt/homebrew/bin/whisper-cli` (Homebrew whisper.cpp) — confirmed real
binary spawn, arg construction, exit-code handling, and stderr-tail
propagation. With a bogus model path, the backend correctly surfaces
`llama_model_load: error loading model` from the binary's stderr.

### Ships

- `packages/embedded-llm/src/llama-cpp-backend.ts` — `LlamaCppTextBackend`
  implements `EmbeddedTextPort`, spawns `llama-cli` with
  `-m <model> -p <prompt> -n <maxTokens> --temp <temp> --no-display-prompt
  --no-warmup -no-cnv` (no-cnv suppresses the interactive REPL banner so
  stdout contains only generated tokens). Strips `[end of text]`, `<|im_end|>`,
  `<|endoftext|>`, `</s>` markers from output. Configurable `timeoutMs`
  (default 120s) and `threads`. Exit code ≠ 0 → rejects with last 5 stderr
  lines as the error message tail.
- `packages/embedded-llm/src/whisper-cpp-backend.ts` — `WhisperCppSttBackend`
  implements `EmbeddedSttPort`, writes audio buffer to a `mkdtemp`'d temp
  directory, spawns `whisper-cli` with `-m <model> -f <audio> -oj -of <basename>
  -np -nt`, reads `<basename>.json` and joins `transcription[].text` with
  spaces. Cleans up the temp dir in a `finally` block (even on whisper-cli
  failure). Optional `-l <lang>` and `-t <threads>`. `parseWhisperJson`
  exported separately for test isolation.
- `packages/embedded-llm/src/factory.ts` — `createEmbeddedTextPort()` and
  `createEmbeddedSttPort()` pick real vs Null based on
  `detectEmbeddedRuntimes()`. Model resolution order: explicit override →
  `SKYTWIN_LLAMA_MODEL`/`SKYTWIN_WHISPER_MODEL` env var → first matching
  file in detected `modelDir` (`*.gguf` for llama, `ggml-*.bin` for whisper)
  → fall back to Null port.
- `findFirstGgufModel()` and `findFirstWhisperModel()` — directory scan helpers
  with safe error handling (returns null if dir missing, readdir throws, or
  statSync fails on individual entries).
- 36 new unit tests across `llama-cpp-backend.test.ts`,
  `whisper-cpp-backend.test.ts`, and `factory.test.ts`. Mocks `node:child_process`
  and `node:fs` so tests never spawn real binaries. Total package now: 58 tests.

### Closes for #187

- AC#1 runtime: real llama.cpp text generation (the binary spawn + parse layer).
  Bundling the model file is a separate distribution concern.
- AC#3 runtime: real whisper.cpp transcription. Voice integration in mobile/desktop
  consumes this via `createEmbeddedSttPort()`.

### Still open for #187

- AC#1 bundling: shipping a default GGUF in installer payload (separate distribution
  concern; runtime accepts any GGUF via env var or model dir).
- AC#2: background download with pause/resume UI (model downloader app work).
- AC#4: Piper TTS — `piper` binary not installed locally; `NullEmbeddedTtsPort`
  remains the production fallback until `brew install piper` (or equivalent)
  lands. Real `PiperTtsBackend` will mirror the spawn pattern of these two.
- AC#5: auto-upgrade model registry (model registry / version-check work).
- AC#6/7/8: UI mode switch + prompt-eval parity + cost dashboard zero-cost
  display.

### How to use

```ts
import { createEmbeddedTextPort } from '@skytwin/embedded-llm';

const port = await createEmbeddedTextPort();
if (port.capabilities.available) {
  const text = await port.generate('Summarize this email: ...', {
    maxTokens: 256,
    temperature: 0.3,
  });
}
// Else: fall back to API-keyed providers via @skytwin/llm-client.
```

Set `SKYTWIN_LLAMACPP_BIN=/path/to/llama-cli` and `SKYTWIN_LLAMA_MODEL=/path/to/model.gguf`
(or `SKYTWIN_LLAMA_MODELS=/dir/with/models/`) to pin a specific binary/model.

## [unreleased] — GitHub Releases auto-update channel + workflow (#188 follow-up)

Closes the real auto-update channel for #188. #223 shipped the scaffold with
`NoopUpdateBackend` and a `provider: generic` placeholder that was removed
because env-interpolation (`${env.SKYTWIN_UPDATE_URL}`) failed CI. This PR
switches to GitHub Releases (`provider: github`), which embeds a static
owner/repo pair in the build config and reads `GH_TOKEN` from the environment
only at publish time — no env vars needed for CI to build cleanly.

### Ships

- `apps/desktop/package.json` — `build.publish` block set to `provider: github`,
  `owner: jayzalowitz`, `repo: skytwin`, `releaseType: release`. `electron-updater
  ^6.6.0` added to `dependencies`.
- `apps/desktop/src/auto-update.ts` — `ElectronUpdaterBackend` class: wraps
  `autoUpdater` from electron-updater, sets `autoDownload = true` and
  `autoInstallOnAppQuit = true` (silent install on next quit), maps result to
  `UpdateCheckResult`. Uses a dynamic `require` so the import is deferred to
  runtime inside a real Electron process and never resolved in tests or headless.
  `defaultBackend(opts?)` factory: returns `ElectronUpdaterBackend` when
  `process.versions.electron` is set, `NoopUpdateBackend` otherwise. `AutoUpdateController`
  constructor now accepts an optional backend and falls back to `defaultBackend()`.
- `apps/desktop/src/main.ts` — On `app.whenReady()` + `app.isPackaged`, constructs
  `AutoUpdateController` and calls `schedulePeriodicChecks()`. On `before-quit`,
  calls `cancelScheduledChecks()`. Skipped in dev mode (unpackaged runs).
- `.github/workflows/release.yml` — Matrix build (macOS/Windows/Linux) triggered on
  `v*.*.*` tags or `workflow_dispatch`. Publishes via `--publish always`. Secret names
  documented in the file header comment block. Until secrets are added, produces
  unsigned artifacts (same posture as before).
- `apps/desktop/src/__tests__/auto-update.test.ts` — 6 new tests (total 23):
  `defaultBackend()` returns Noop in test env, returns `ElectronUpdaterBackend` when
  `process.versions.electron` is set (mocked inline), handles `channel: beta`, and
  two constructor-level regression guards.

### How to cut a release

```
git tag v0.x.y && git push origin v0.x.y
```

The workflow fires automatically. Binaries appear in GitHub Releases once the
matrix jobs complete (typically 15-30 min). Clients running the previous version
will pick up the update on their next 6-hour check cycle (or on next launch).

### Code-signing status

Signing is conditional on secrets being present in the GitHub repo:
`MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` (macOS);
`WIN_CERT_PFX_BASE64`, `WIN_CERT_PASSWORD` (Windows).
Without these secrets the workflow publishes unsigned artifacts. Unsigned builds
auto-update correctly but trigger OS security warnings on first launch.
Certificate procurement is tracked separately.

### Out of scope

- In-app update notification UI (deferred to v1.1 polish)
- Beta channel automation (stable channel only for v1)
- Delta/patch deployment (electron-updater handles this automatically once the
  channel has at least two releases)

---

## [unreleased] — PR merge gate codified in CLAUDE.md

Adds a three-step pre-merge gate to `CLAUDE.md` (`/review` → Copilot
review resolved → `/document-release`), plus two non-negotiable rules:
NEVER push to main directly, ALWAYS add Copilot as reviewer. Adapted
from the gate `Robot-Robot-and-Human/RRH` uses; closes the gap that
allowed ~70 unaddressed Copilot comments to accumulate across this
week's 15 epic PRs (cleaned up by the #226 → #232 stack).

The existing six "habits" bullets (re-render path tracing, shared-types
dist verification, unit tests for hardening, separate post-/review
commits, source-of-truth doc citations) are kept as supporting guidance
under a renamed sub-section.

## [unreleased] — Zero-trust Docker runtime (#183 AC#4 closes)

Completes AC#4 of issue #183. PR #222 shipped the policy + UI half (riskModifier
+1, force-approve, toggle endpoints, capability-detail card). This PR adds the
runtime enforcement: stdio MCP servers with `zeroTrustMode=true` are now spawned
inside a Docker container with `--network=none` so the server process has no
network access.

### Ships

- `packages/mcp-host/src/docker-spawn.ts` — `isDockerAvailable()`,
  `spawnInDockerNoNetworkAsync()` (async, resolves `npm root -g`),
  `spawnInDockerNoNetwork()` (sync, uses fallback path), and `buildDockerArgs()`
  (exported for testing). Resource caps: `--memory=512m --cpus=1` by default.
  Container flags: `--network=none --rm --init --read-only --cap-drop=ALL
  --security-opt=no-new-privileges --user=uid:gid`.
- `packages/mcp-host/src/docker-stdio-transport.ts` — `DockerStdioTransport`
  implements `Transport` using pre-spawned Docker stdin/stdout. Wires container
  exit to `onclose` so the McpHost CircuitBreaker is notified.
- `McpServerConfig.zeroTrustMode?: boolean` and
  `McpServerHandle.failedToIsolate?: boolean` added to
  `packages/mcp-host/src/types.ts`.
- `McpHost.installServer` wired: stdio + `zeroTrustMode=true` + Docker available
  → `DockerStdioTransport`; Docker unavailable → warning logged,
  `failedToIsolate=true`, regular spawn (graceful fallback).
- 18 unit tests + 1 integration test in
  `packages/mcp-host/src/__tests__/docker-spawn.test.ts`. Integration test runs
  when Docker is available and verifies `--network=none` blocks outbound fetch
  from the container (exits 0 = blocked).

### Constraints (document clearly)

- **stdio transport only.** HTTP/SSE servers are remote processes; applying
  `--network=none` would sever the connection entirely. `zeroTrustMode` is
  silently ignored for `transport: 'http'` and `transport: 'sse'`.
- **User must pre-install MCP packages on the host** via `npm install -g
  <package>`. The host's global `node_modules` directory (resolved via `npm root
  -g`) is mounted read-only into the container so `npx` can find packages without
  internet access during startup. See code comments in `docker-spawn.ts` for the
  rationale.
- **Resource cap defaults:** 512 MB memory, 1 CPU. Configurable via
  `McpServerConfig.resourceLimits.memoryMb`.
- **Graceful fallback:** if Docker is not running, the server starts without
  isolation and `McpServerHandle.failedToIsolate` is set to `true`. The UI can
  surface "isolation requested but Docker not available" (deferred).

### Out of scope

- HTTP/SSE transport zero-trust — network required by design. Documented.
- Per-server OAuth domain allowlist — needs sidecar HTTP proxy or iptables. Defer.
- Pre-built containers per MCP server — too invasive for v1. Defer.
- Auto-install MCP packages inside container — needs network. Defer.
- "Isolation requested but Docker not available" UI banner — `failedToIsolate`
  field is set; UI reads it in a follow-up.

### Closes

- #183 AC#4

## [unreleased] — Turnkey distribution config (#188 partial)

Scaffolds the electron-builder signing configuration, build orchestration
scripts, and auto-update wiring needed for a signed installer release. All
credentials are env-var-driven — no certificate material appears in the
codebase. Unsigned builds continue to work exactly as before; signing
activates only when `SKYTWIN_SIGN_RELEASE=true` and the required env vars
are present.

### Ships

- electron-builder config: minimal mac/win/linux targets. No env-interpolation
  in build config (those failed CI schema validation when env vars were unset).
- `apps/desktop/scripts/sign-and-notarize.ts` — orchestration helper validating
  required env vars when `SKYTWIN_SIGN_RELEASE='true'`.
- `apps/desktop/src/auto-update.ts` — `AutoUpdateController` with injectable
  `UpdateBackend`. `NoopUpdateBackend` default; real `ElectronUpdaterBackend`
  lands when E2E confirms.
- `apps/desktop/scripts/build-single-binary.sh` — bundles api+worker+web into
  `apps/desktop/dist/embedded/`.
- 17 unit tests for `AutoUpdateController`.

### Out of scope (deferred)

- Real signing certificates — env-var only; certs flow via CI secret storage
- Real CDN URL — env-var only
- Real `ElectronUpdaterBackend` implementation — needs E2E
- SQLite-vec embed — v1.1 per #197
- Auto-update CI workflow — separate ops PR

## [unreleased] — Mobile Capabilities + Briefing screens (#179 partial)

Read-only mobile UX for Capabilities + Briefing. Voice STT/TTS, push
notifications, deep-linking, and full offline support all need real
device testing — those are deferred.

### Ships

- `apps/mobile/src/screens/CapabilitiesScreen.tsx` — installed capabilities
  list with name, status badge, last-active timestamp, zero-trust indicator,
  pull-to-refresh. Pending suggestions at top with Snooze / Dismiss
  (Install redirects to web). Tap row → detail.
- `apps/mobile/src/screens/CapabilityDetailScreen.tsx` — skills, monthly
  spend meter, zero-trust badge, "View provenance" link via `Linking`.
  Read-only — no inline edit forms.
- `apps/mobile/src/screens/BriefingScreen.tsx` — today's headline, key
  signals, pending-approvals count, pull-to-refresh.
- `apps/mobile/src/services/api-client.ts` — `fetchCapabilities`,
  `fetchCapabilityDetail`, `fetchTwinBriefing` + 7 new types.
- `apps/mobile/src/App.tsx` — Briefing + Capabilities tabs added to the
  bottom tab bar (now 5 tabs). Capability detail is a sub-page inside the
  Capabilities tab (state-driven, resets on tab switch — avoids nested
  navigators).
- 36 new unit tests in `capabilities-briefing.test.ts`.

### Defers (out of scope this session)

- Voice STT/TTS — needs device microphone + speakers
- Push notifications — needs APNs/FCM credentials
- Deep-linking web → mobile — needs URL scheme registration
- Full offline support — needs sync engine work
- Install / activate from mobile — management stays on web

## [unreleased] — DXT install confirm flow (#180 follow-up)

Closes the backend half of the DXT import flow. `POST /api/dxt/import` now
persists a `dxt_imports` row (`status='pending'`) so the user can confirm or
reject in a dedicated step. A second call to the confirm endpoint installs
the capability by inserting into `mcp_servers`, writing a provenance node, and
returning the new server ID.

### Ships

- **Migration `035-dxt-imports.sql`** — `dxt_imports` table with
  `pending | installed | rejected | failed` status lifecycle; composite index on
  `(user_id, status, imported_at DESC)`. Also extends `cpn_node_type_check`
  to include `'manual_install'`.
- **`dxtImportRepository`** (`packages/db/src/repositories/dxt-import-repository.ts`)
  — `create`, `findById`, `listForUser`, `markRejected`, `markInstalled`,
  `markFailed`. Exported from `@skytwin/db`.
- **`POST /api/dxt/import`** updated — now persists a pending row and returns
  `importId` alongside the preview. The old `note` field is removed.
- **`POST /api/dxt/imports/:id/confirm`** — ownership-checked, pending-only,
  re-verifies SHA-256 on stored blob, inserts into `mcp_servers`, writes
  `manual_install` provenance node, returns `{ status, serverId, registryId }`.
- **`POST /api/dxt/imports/:id/reject`** — ownership-checked, pending-only,
  returns 204. Audit trail.
- **`GET /api/dxt/imports`** — lists all imports for the user, newest first.
  No blob bytes in response. Supports `?status=` filter.
- **Web page `apps/web/public/js/pages/dxt-imports.js`** — route `#/dxt/imports`,
  singleton delegator, pending review list with expand-to-review + Install /
  Reject buttons, history with status badges. Wired into `app.js`.
- **14 new tests** — 9 in `dxt-import-confirm-flow.test.ts` (API layer) +
  5 in `dxt-import-repository.test.ts` (db layer).

### Defers

- Drag-drop UI on the desktop (Electron file-picker integration) — needs
  real Electron testing environment.
- Bulk import — one artifact at a time by design.
- Cross-instance federation (push) — DXT is one-way file transfer.

## [unreleased] — Copilot review sweep, batch 1 (security + correctness)

Audited Copilot comments across this week's epic PRs (#198, #206-#215,
#218, #219, #221, #222) and fixed the security-critical and obviously-
broken items in one pass. Lower-severity items (frontend nits, doc drift,
adaptive-prompt input mismatches, observability rollup architecture, vault
rotation polish) are scoped into themed follow-up PRs.

### Security

- **Shell injection — `@skytwin/memory-gbrain`.** `searchSemantic` was
  building a shell command string with the user query interpolated through
  `JSON.stringify`. Replaced with `execFileSync` (no shell), so query
  metacharacters (`$()`, backticks, `;`, `&&`, …) are passed as a single
  argv element and cannot inject. Added regression test using a malicious
  query.
- **PII leak via array payloads — `redactPII` and `redactPayload`.** Both
  helpers in `apps/twin-mcp-server/src/audit/provenance-writer.ts` and
  `apps/api/src/routes/capabilities.ts` skipped arrays, so PII in
  array-of-object payloads (e.g. `recipients: [{email: ...}]`) was
  written to provenance and returned in API responses unredacted. Both
  now recurse through arrays.
- **PII leak — `GET /api/capabilities/suggestions`.** The response
  spread `...row` over the suggestion, returning the raw
  `evidence_sources` JSONB (the unredacted source signals) alongside the
  redacted `evidence` preview. Switched to an explicit field projection
  so only the safe preview leaves the API.
- **Broken email-redaction regex — `[A-Z|a-z]{2,}`.** Inside a character
  class `|` is literal, so the regex was matching `|` as a TLD char and
  failing to match valid TLDs. Fixed to `[A-Za-z]{2,}` in both subject
  and body redactions.

### Correctness

- **Credential vault never engaged in production.** `DbTokenStore` exposes
  `setKeyCache()` for at-rest encryption + lazy migration, but only the
  worker creates `DbTokenStore` and never called `setKeyCache`. The
  encryption feature was dead weight: lazy migration never fired, so
  existing plaintext tokens stayed plaintext forever. Added a
  worker-local `KeyCache` and wired it. The cache is empty until
  cross-process unlock IPC lands (#212 follow-up), but the seam now
  exists and a comment documents the limitation.
- **DXT routes broken under real auth.** `getUserId(req)` read
  `req.user?.id`, but production session-auth middleware sets
  `req.authenticatedUserId`. All DXT endpoints returned 400 unless
  callers passed `?userId=` explicitly. Switched to read
  `authenticatedUserId` first; tests updated to mirror production
  middleware.
- **Twin MCP provenance only on success.** Per safety invariant, every
  external-agent tool call must produce an audit row. The previous
  pattern only awaited `writeExternalAgentProvenance` after the tool
  succeeded — failed calls were invisible. Wrapped each handler in
  try/finally so the audit fires for both success and failure; a
  separate try/catch ensures provenance failures never mask the original
  tool result/error.
- **Migration 027 inline partial-index syntax.** CockroachDB does not
  support `INDEX (col) WHERE ...` inside `CREATE TABLE`. Pulled the two
  affected partial indexes out as standalone `CREATE INDEX IF NOT EXISTS`
  statements (matching the pattern in 011-sessions.sql). Idempotent if
  the migration already applied; safe if it hadn't.
- **Onboarding always recorded `first_run_choice = 'about-me'`.** Three
  call sites (skip-recipe, install-recipe, complete) hard-coded the
  string regardless of which entry path the user took. Added
  `_wizardState.firstRunChoice` set on the welcome-screen choices and
  read everywhere downstream — email and computer users now record their
  real path.
- **Briefing generator dropped users past 500.** `getActiveUserIds`
  ran a single `LIMIT 500` query and silently dropped the rest. Switched
  to a 500-row paged scan over `mcp_servers` ordered by `user_id`.
- **Zero-trust mode is helpers-only.** The `applyZeroTrustOverride` and
  `getEffectiveRiskModifier` helpers exist and are unit-tested, but no
  production caller invokes them — toggling the UI badge does not
  change runtime behavior. Updated CHANGELOG and capability-detail
  copy to be honest about that, with a #222 follow-up tracked for the
  decision-pipeline wiring.

### Tests

- Added shell-injection regression test for `GbrainMemoryPort`.
- Added array-of-object PII redaction tests for `redactPII` and
  `redactPayload` (one of which previously asserted the bug as
  expected behavior — corrected).
- Added "capabilities() returns empty when not installed" test for
  `GbrainMemoryPort`.

### Fixed (post-/review)

- **Migration 027 idempotency.** Added defensive
  `DROP INDEX IF EXISTS` for the auto-named partial indexes CockroachDB
  would have created had an earlier run accepted the inline form. A
  re-apply now yields exactly one partial index per predicate, not two.
- **Briefing-generator pagination scales linearly.** Switched from
  `LIMIT/OFFSET` to keyset pagination (`AND user_id > $last`) so
  per-page cost stays flat as the user table grows, instead of paying
  to scan + skip earlier rows on every page.
- **gbrain test mock variable rename.** `mockExecSync` →
  `mockExecFileSync` so the variable name matches the API under test.
- **DXT-route docstring honesty.** Removed the misleading "other route
  modules use the same order" claim — they don't.

## [unreleased] — Zero-trust mode policy + UI (#183 AC#4 partial)

Closes the policy + UI half of #183 AC#4. The container runtime hooks
themselves (the actual `--network=none` spawn) live in the desktop app
and are deferred to #180's environmental work.

### Added — Backend policy logic (helpers; not yet wired into pipeline)

- `getEffectiveRiskModifier(server)` returns `1 + (zero_trust_mode ? 1 : 0)`,
  stacking on the existing `MCP_HOST_TRUST_PROFILE.riskModifier` of 1.
- `applyZeroTrustOverride()` returns a `PolicyDecision` that forces approval
  for every action when `zero_trust_mode` is true.
- Both helpers are exported from `@skytwin/policy-engine` and unit-tested,
  but **no production caller invokes them yet** — the decision pipeline
  wiring is a #222 follow-up. Until that lands, enabling zero-trust mode
  records a provenance event and changes the UI badge but does not change
  runtime behavior.

### Added — `mcp-server-repository.setZeroTrustMode(id, enabled)`

Toggles the existing `mcp_servers.zero_trust_mode` column.

### Added — Migration `034-zero-trust-provenance.sql`

Extends `capability_provenance_nodes.node_type` CHECK constraint to
include `'zero_trust_change'` for toggle audit.

### Added — API routes

- `POST /api/capabilities/:id/zero-trust/enable`
- `POST /api/capabilities/:id/zero-trust/disable`

Both ownership-checked, both write a `capability_provenance_nodes` row
with `payload: { from, to }`.

### Added — Web UX

New "Zero-trust mode" card on `apps/web/public/js/pages/capability-detail.js`
with state badge, toggle button, and explanation text.

### Tests

18 new (6 policy-engine + 4 db + 8 api).

### Out of scope (deferred)

- Container runtime hooks — needs Docker / Electron testing, lives in #180
- Per-server allowlist of OAuth-provider domains — lives in #180
- E2E verifying the container has no internet — needs Docker

## [unreleased] — Embedded LLM port scaffold (#187 partial)

Scaffolds the runtime detection + port interfaces so the rest of the
codebase can call into a future embedded-LLM implementation through a
stable contract. Real llama.cpp / Whisper / Piper integrations are
explicitly deferred — they require binary distribution and integration
testing on real models.

### Added — `@skytwin/embedded-llm`

- `detectEmbeddedRuntimes()` — checks `which`/`where` for `llama-cli`,
  `whisper-cli`, `piper`. Honors env vars (`SKYTWIN_LLAMACPP_BIN`,
  `SKYTWIN_WHISPER_BIN`, `SKYTWIN_PIPER_BIN`) for explicit overrides.
  Never spawns the binaries — existence-check only.
- `EmbeddedTextPort` / `EmbeddedSttPort` / `EmbeddedTtsPort` interfaces
  with `Null*` fallback impls. Calling `generate` / `transcribe` /
  `synthesize` on a Null impl throws `NotAvailableError` with a typed
  `runtime` field.
- 22 tests across runtime-detector and null-ports.

### Explicitly deferred

- Real llama.cpp / Whisper / Piper integration — needs binaries
- Model auto-download / auto-upgrade — needs CDN + cryptographic
  verification of model artifacts
- Speaker diarization, voice cloning, fine-tuning — out of scope for v1
- Web UI for model management — needs the real backend first

### Known interface gaps for the real-implementation PR

- `generate()` returns `Promise<string>` (full completion) — no token
  streaming. llama.cpp typically streams; the real PR may add an
  overload or a separate `generateStream()` method.
- `transcribe()` takes a raw `Buffer` — audio format implicit. Whisper
  needs a known format; the real PR may add `opts.format`.
- `synthesize()` returns a raw `Buffer` — audio mime type unspecified.
  The real PR may return `{ audio: Buffer; mimeType: string }`.
- No `init`/`dispose` lifecycle — model loading happens internally.
  The real PR may add a `create(opts)` factory.

## [unreleased] — DXT export/import scaffold (#180 partial)

The capability-transfer pipeline that `docs/dxt-transfer.md` (shipped in #211)
described — implemented end-to-end except for the desktop drag-drop UI and
the actual confirmed-install flow.

### Added — `@skytwin/dxt`

New package implementing the binary artifact format:

- 4-byte magic `DXT1` + 4-byte version + 32-byte SHA-256 + 8-byte length + JSON payload
- `serialize(input)` packs an `mcp_servers` row + skills into the binary form
- `deserialize(blob)` returns a typed `DxtResult<T>` (no thrown exceptions
  on user input — boundary contract)
- `redactCommand(args)` masks any `--token=*` / `--api-key=*` / `--secret=*`
  CLI argument before it reaches the artifact

15 unit tests (round-trip, magic mismatch, version mismatch, length mismatch,
SHA-256 tamper detection, redaction).

### Added — `dxtExportRepository` (`@skytwin/db`)

`create(input)`, `findById(id)`, `listForUser(userId)` against the
existing `dxt_exports` table from migration 027.

### Added — `apps/api/src/routes/dxt.ts`

Four routes wired under `sessionAuth + requireOwnership`:

- `POST /api/dxt/export/:serverId` — serialize + persist + return base64 blob
- `GET  /api/dxt/exports` — metadata-only listing
- `GET  /api/dxt/exports/:id/blob` — download `application/octet-stream`
- `POST /api/dxt/import` — preview-only deserialization with detection of
  whether the capability is already installed

9 API integration tests (UUID validation, ownership checks, round-trip
export → import, magic-mismatch on garbage, missing-blob 400).

### Out of scope (deferred to environmental work)

- Drag-drop UI on the desktop app — needs Electron testing
- The actual install-from-DXT flow (preview only — explicit-confirm + install
  step deferred)
- Idle bridge from #180
- Zero-trust container hooks from #180 / #183 AC#4

## [unreleased] — Always-on service: headless daemon scaffold (#191 partial)

Code-bound subset of #191. Ships:

- **Headless daemon entry point** (`apps/desktop/src/headless.ts`) — runs the
  API + worker without spawning Electron windows. Listens on
  `SKYTWIN_API_PORT` (default 4000), exposes `/health`, handles SIGTERM →
  graceful shutdown.
- **Tray menu data definitions** (`apps/desktop/src/tray.ts`) — pure-data
  `buildTrayMenuItems(state)` returning `{ label, action, enabled }[]` for
  the four states (idle / scanning / acting / paused). Testable without
  Electron. Wrapper `applyTrayMenu()` exists but is not unit-tested.
- **Service install scripts** — `install-launchd.plist` (macOS),
  `install-systemd.service` (Linux), `install-windows-service.ps1`
  (Windows). Static config files. Reference `~/.skytwin/logs/` and
  `/usr/local/bin/skytwin` as documented placeholders pending #188's
  signed-binary install path.

### Out of scope (deferred to environmental work)

- The actual Electron tray (icon registration, click handling) — needs UI testing
- Auto-launch on system startup (Settings toggle) — needs UI work
- E2E tests on real macOS / Linux / Windows (#191 AC#7)

8 unit tests for headless + tray data layer.

## [unreleased] — Credential vault passphrase rotation (#183 vault follow-up)

Implements the key-rotation flow for the per-user credential vault.

### Added — `POST /api/credential-vault/rotate`

New endpoint for passphrase rotation. Accepts `{ currentPassphrase, newPassphrase }`.
Verifies the current passphrase (rate-limited 5/min/user), derives a new key from a
new random salt, re-encrypts every `oauth_tokens` row for the user inside a single
serialisable CockroachDB transaction, bumps `current_key_version` and updates
`passphrase_salt` + `passphrase_hash` in `user_credential_vault_meta`, then refreshes
the in-memory `KeyCache`. Returns `{ status: 'rotated', tokensReencrypted: N, keyVersion: N }`.
On any transaction failure the ROLLBACK leaves the original passphrase intact.

### Added — `oauthRepository.listEncryptedForUser(userId, client?)`

SELECT all `oauth_tokens` rows with `encrypted_access_token IS NOT NULL` for the given
user. Accepts an optional `PoolClient` so the rotation transaction's serialisable
isolation actually covers the read.

### Added — `oauthRepository.rotateEncrypted(id, input, client?)`

UPDATE encrypted columns for a single row without touching plaintext columns (which
are already NULL for fully-migrated rows). Accepts an optional `PoolClient`.

### Added — `credentialVaultMetaRepository.rotatePassphrase(userId, input, client?)`

UPDATE `user_credential_vault_meta`: new salt, new passphrase hash, `current_key_version + 1`,
`rotated_at = now()`. Accepts an optional `PoolClient`.

### Added — `apps/web/public/js/pages/credential-vault.js`

New web page at hash route `#/credential-vault`. Shows vault status (initialized/unlocked,
key version, last rotated), init form, unlock form, rotate form, and lock button. Uses
the singleton-delegator pattern (`_credentialVaultListenerWired` guard, hash-route gated).
Wired into `app.js` routes and `index.html` nav.

## [unreleased] — Lazy credential-vault migration: observability hook (#183 follow-up)

The fire-and-forget `_lazyMigrate` path in `DbTokenStore.getToken` previously
swallowed migration errors silently — a flaky DB could leave a user un-migrated
indefinitely with no visible signal.

### Changed — `packages/connectors/src/oauth/db-token-store.ts`

The `.catch()` arm of the lazy-migration `Promise` now:

- Increments `lazyMigrationFailureCounter.count` (exported counter that
  downstream observability tooling can poll).
- Logs a `warn` line with `userId`, `provider`, `rowId`, and the error message.
  Plaintext tokens / passphrases / keys are NEVER logged.

The caller still receives the plaintext value (backward compat), so a single
failure does not block the user; but persistent failures are now visible.

1 new regression test asserts the counter increments and the
`lazyMigrationFailureCounter` export works.

## [unreleased] — memory-gbrain + memory-hybrid scaffolding (#197 partial scaffold for v1.0.5)

SKELETON only. No live gbrain integration is included in this entry.

### Added — `@skytwin/memory-gbrain`

New package at `packages/memory-gbrain/`. Implements `MemoryPort` from
`@skytwin/memory-port` with best-effort gbrain CLI integration:

- `src/cli-detector.ts` — detects whether `gbrain` is in PATH via `which`/`where`; returns false on any error so callers fall back cleanly.
- `src/gbrain-port.ts` — `GbrainMemoryPort` implements `MemoryPort`. Declares capabilities `{ semantic_search, code_aware_search }` only. `searchSemantic` shells out to `gbrain search --json --query=... --limit=N` with a 5 s hard timeout; returns `[]` (not an error) when gbrain is absent, exits non-zero, or times out. All write methods and `walkGraph`/`getEpisodes`/`getTriples`/`summarize`/`compress` throw `NotImplementedError` — the `HybridMemoryPort` routes these to MemPalace.
- No PII in logs: only operation names and result counts are logged, never query text.

### Added — `@skytwin/memory-hybrid`

New package at `packages/memory-hybrid/`. `HybridMemoryPort` composes any two `MemoryPort` implementations:

- Constructor: `new HybridMemoryPort({ primary, secondary, routing? })`.
- Writes go to BOTH backends. Primary write must succeed; secondary write is best-effort (failures logged, never propagated).
- Reads route per-capability: `searchSemantic` and `code_aware_search` go to primary if it declares the capability; `walkGraph`, `getEpisodes`, `getTriples`, `summarize`, `compress` go to secondary by default. Overrideable via `RoutingRules`.
- `capabilities()` returns the union of primary + secondary capabilities.
- `exportAll`/`importAll` route to secondary only.
- Verified type-compatible with `MemPalaceMemoryPort` as secondary (compile-time assertion in tests).

### Explicitly deferred to v1.0.5

- CRDB driver shim (`@skytwin/memory-gbrain-crdb-adapter`) — not included.
- Full gbrain MCP integration — not included.
- Embedding pipeline wiring — not included.
- `federated_sources` capability (gbrain v1.1+) — not included.
- Web UI for memory backend selection — not included.

## [unreleased] — Capability changelog flow + new-skill opt-in (#184 follow-up)

Implements #184 AC#2 deferred from the previous PR: `changelog://` resource
fetching, new-destructive-skill opt-in prompts, hard-rail execution block, and
weekly worker sweep.

### Added — Migration `033-mcp-server-changelogs.sql`

Two new tables:
- `mcp_server_changelogs` — one row per installed server; tracks
  `current_version`, `raw_text`, `fetched_at`, `last_seen_skills`, and
  `last_known_destructive_skills`. Updated on install, on `list_tools`
  refresh, and on the weekly worker sweep.
- `pending_skill_opt_ins` — pending opt-in prompts for newly added
  destructive skills. Unique on `(server_id, skill_name)`. Partial index
  on unresolved rows.

### Added — `mcpServerChangelogRepository` (`@skytwin/db`)

Methods: `upsert`, `getForServer`, `addPendingOptIn` (idempotent),
`listPendingOptInsForUser`, `acceptOptIn`, `rejectOptIn`,
`hasPendingOptIn`.

### Added — `McpHost.fetchChangelog` + `isDestructiveSkill` (`@skytwin/mcp-host`)

`fetchChangelog(serverId)` uses `client.listResources()` to locate a
`changelog://` resource and reads its text content. Version extraction
uses a `## vX.Y.Z` / `# X.Y.Z` heuristic (first match wins). Returns
null on any error — best-effort.

`isDestructiveSkill(skillName)` heuristic gating for opt-in prompts.
Matches create/delete/update/write/send/post/commit/push/merge/mutate/set/remove.

`onChangelogFetch` hook added to `McpHostOptions` — mirrors `onToolCall`
pattern. Wired in `execution-setup.ts` to persist changelog snapshots.

Hard rail: `checkPendingOptIn` injected from `execution-setup.ts` blocks
execution of any destructive skill that has an unaccepted `pending_skill_opt_ins`
row. Fail-safe: if the check itself throws, execution is blocked.

### Added — Worker job `changelog-poll.ts` (7-day cadence)

`runChangelogPollJob` iterates all active MCP servers, rate-limits per server
to 12 hours, diffs new destructive skills against `last_known_destructive_skills`,
and writes opt-in prompts for new ones. Wired in `apps/worker/src/index.ts`
alongside the existing metrics-rollup pattern.

### Added — API routes (in `createCapabilitiesRouter`)

- `GET  /api/capabilities/:id/changelog` — ownership-checked changelog read
- `GET  /api/capabilities/pending-opt-ins` — pending opt-in feed for user
- `POST /api/capabilities/pending-opt-ins/:id/accept` — accept with ownership check
- `POST /api/capabilities/pending-opt-ins/:id/reject` — reject with ownership check

### Added — Web UI extensions

`apps/web/public/js/pages/capability-detail.js` — Changelog card (version badge
+ collapsible raw_text). Singleton delegator unchanged.

`apps/web/public/js/pages/capabilities.js` — "New skills awaiting opt-in" section
at top of page with Accept/Reject buttons. Uses existing `_capabilitiesListenerWired`
singleton guard and adds `accept-opt-in` / `reject-opt-in` to the delegator.

## [unreleased] — Credential vault envelope encryption (#183 follow-up)

Implements AC#5 from issue #183: envelope encryption of OAuth tokens in the
database. Plaintext `access_token` / `refresh_token` columns are preserved for
backward compatibility; encrypted columns are added alongside them.

### Added — `packages/db/src/migrations/032-encrypted-oauth-tokens.sql`

Adds encrypted columns to `oauth_tokens`:
`encrypted_access_token BYTEA NULL`, `encrypted_refresh_token BYTEA NULL`,
`encryption_iv BYTEA NULL`, `encryption_tag BYTEA NULL`,
`encryption_key_version INT NOT NULL DEFAULT 1`. Drops `NOT NULL` on the
plaintext columns so lazy migration can clear them to actual `NULL`.
Also creates `user_credential_vault_meta` table for per-user passphrase salt
and verification hash.

### Added — `@skytwin/credential-vault`

New package at `packages/credential-vault/`.
- `key-derivation.ts` — scrypt-based passphrase KDF (N=32768, r=8, p=1,
  keylen=32). Exports `deriveKey`, `generateSalt`, `hashDerivedKey`,
  `verifyPassphrase`, `MIN_PASSPHRASE_LENGTH`.
- `envelope.ts` — AES-256-GCM encrypt/decrypt with a fresh 96-bit IV per call.
- `key-cache.ts` — in-process TTL key cache; evicts after 1 hour by default.
  Keys are NEVER persisted.

**Crypto choice note:** The issue spec called for Argon2id. Node.js has no
built-in Argon2id; the `argon2` npm package requires native compilation and is
a deployment hazard in this monorepo. We substitute `crypto.scrypt`, which is
memory-hard (comparable security posture to Argon2id), ships with Node 20+,
and has extensive production use. Parameters: N=2^15, r=8, p=1, keylen=32.

### Added — `apps/api/src/routes/credential-vault.ts`

Four routes under `sessionAuth + requireOwnership`:
- `POST /api/credential-vault/init` — generates salt, derives key, stores hash.
  Returns 422 for passphrase < 12 chars, 400 if already initialised.
- `POST /api/credential-vault/unlock` — verifies passphrase, populates KeyCache.
  Rate-limited to 5 attempts per minute per user; returns 429 on breach.
- `POST /api/credential-vault/lock` — evicts key from KeyCache (idempotent).
- `GET /api/credential-vault/status` — returns `{ initialized, unlocked }`.

### Enhanced — lazy migration on OAuth token reads

`packages/connectors/src/oauth/db-token-store.ts`:
1. Encrypted columns present + vault unlocked → decrypt and return.
2. Plaintext present + vault unlocked → fire-and-forget encrypt (lazy migrate);
   plaintext columns cleared to NULL.
3. Plaintext present + vault locked → return plaintext (backward compat).
4. Encrypted + vault locked → throw "credentials unavailable".

Type widening: `OAuthTokenRow.{access_token,refresh_token}` are now
`string | null`. Updated all call sites (credential-provider, oauth routes).

## [unreleased] — Provenance graph + multi-modal evidence + DXT transfer doc (#184)

Implements 3 of 4 product acceptance criteria from #184. The capability
changelog flow (AC#2) is deferred to a follow-up PR — it requires
upstream MCP server coordination (`changelog://` resource fetching +
weekly worker sweep). DXT export/import operations themselves remain
in #180; this PR ships the user-facing transfer documentation only.

### Added — Provenance graph visualization

`apps/web/public/js/pages/provenance-graph.js` — vanilla SVG/JS
force-directed graph (no D3 or external charting lib). Hash route
`#/provenance`. Filter by node type and time window. Click a node →
side flyout with full payload. Singleton-delegator pattern (hash-route
gated, no inline event handlers).

### Added — `GET /api/capabilities/provenance-graph`

Returns `{ nodes, edges }` from `capability_provenance_nodes` +
`capability_provenance_edges` for the requesting user. Filter
parameters: nodeType, since (ISO timestamp), serverId, limit (default
200, max 500). Edges only included when both endpoints are in the
returned node set. PII redaction applied before serialisation.

### Added — Multi-modal evidence in AppSuggestion responses

`GET /api/capabilities/suggestions` now attaches an `evidence` array
to each suggestion. Per-signal previews built server-side via
`buildEvidencePreview(signal)`:

- **Email**: subject + max-80-char snippet, with email addresses and
  phone numbers stripped to `[email]` / `[phone]` placeholders.
- **Calendar**: event title + start time.
- **File (image, ≤512KB)**: thumbnail data URL.
- **File (other)**: name, extension, size in KB.
- **Code file**: language + first 10 imports — NEVER raw content.

The capabilities page renders the previews inline under each
suggestion card.

### Added — `docs/dxt-transfer.md`

User flow describing how to export a DXT artifact on machine A and
drop it on machine B. Privacy considerations, what the artifact does
and does not contain (no OAuth tokens — user must reconnect on the
new machine), and limitations vs live federation (deferred to v1.1).

### Consolidated PII redaction

`redactPayload()` is now the single canonical PII redaction function
in `capabilities.ts`, exported and shared across `/audit` (#183),
`/provenance-graph` (#184), and the evidence-preview path. Match is
exact (not regex) so legitimate fields like `serverName`, `skillName`,
`recipeName` stay visible. The duplicate `redactPII` from #183 has
been removed.

## [unreleased] — Observability + audit + cost ceilings (#183)

Implements three of the five acceptance criteria from issue #183.
Zero-trust container isolation (AC#4) and credential-vault Argon2id
encryption (AC#5) are deferred to a follow-up PR.

### Added — `@skytwin/observability`

New package: in-memory ring buffer (`MetricsCollector`) collects per-server
tool call outcomes (latency_ms, success, spend_cents). `MetricsRollupService`
drains the buffer and writes 1-minute rollup rows to `mcp_server_metrics`.
Threshold constants (`SUCCESS_RATE_WARN_THRESHOLD`, `LATENCY_P95_WARN_MS`,
`BUFFER_NEAR_FULL_FRACTION`) are exported so the UI adapts without a rebuild.
6 unit tests for MetricsCollector, 6 for MetricsRollupService.

### Added — `packages/db/src/repositories/mcp-server-metrics-repository.ts`

New repository: `writeBucket` (upsert with ON CONFLICT accumulation),
`getRecent`, `getSparkline`. Wired into the db package exports.

### Added — `apps/worker/src/jobs/metrics-rollup.ts`

Worker job `runMetricsRollupJob()` drains the shared `MetricsCollector`
every 60 seconds and writes to DB. Exports `sharedMetricsCollector`
singleton for mcp-host integration.

### Added — `apps/web/public/js/pages/capabilities-audit.js`

Capability audit trail page at `#/capabilities/audit`. Paginated list of
`capability_provenance_nodes` with filters: event type, date range, and
free-text keyword search. Singleton delegator pattern (hash-gated, no
stacked listeners). Wired into `app.js` routes table.

### Added — `GET /api/capabilities/audit`

Paginated provenance node endpoint with additive SQL filters (nodeType,
serverId, dateFrom, dateTo, q). PII fields (email, name, token, password,
credential) are redacted before serialisation.

### Added — `GET /api/capabilities/:id/metrics`

Returns sparkline data (latency p50/p95, success rate) and recent bucket
rows for the capability detail page.

### Enhanced — `packages/policy-engine/src/spend-tracker.ts`

Added `checkMonthlyLimit()` and `getMonthlySpendForApp()` to `SpendTracker`.
`resolveEffectiveCaps()` now returns `maxMonthlySpendCents` from the
per-app override (clamp-down semantics preserved). `SpendRepositoryPort`
gains `getMonthlyTotal()`. 8 new unit tests.

### Enhanced — `apps/web/public/js/pages/capability-detail.js`

Added "Performance" section with SVG sparklines (latency p50/p95, success
rate, no external charting library). Added "Monthly spend" meter: "$X.XX
of $Y.YY used this month" progress bar; shows "No monthly cap configured"
with settings link when none is set.

## [unreleased] — Twin-as-MCP-server (#182)

SkyTwin now exposes itself as an MCP server so external agents (Claude
Desktop, Cursor, future hosts) can read the user's memory, query
preferences, propose actions for review, and subscribe to recent
signals — under explicit, scope-limited tokens.

### Added — `@skytwin/twin-mcp-server` app

New app under `apps/twin-mcp-server/` running an HTTP MCP endpoint via
`StreamableHTTPServerTransport` (stateless mode: each request gets a
fresh `McpServer` with tools filtered to the authenticated token's
scope). Tools: `whoami`, `query_memory`, `get_preferences`,
`propose_action`, `subscribe_signals`. 34 unit tests.

### Added — External-agent token model

Migration `031-external-agent-tokens.sql` adds `external_agent_tokens`
(per-user issuance, scope, agent_name, hashed token, revoke timestamp).
Tokens are SHA-256 hashed at rest; the plaintext is returned exactly
once at issuance. New repository
`packages/db/src/repositories/external-agent-token-repository.ts` and
HTTP routes under `apps/api/src/routes/external-agents.ts` for issue /
list / revoke. 9 API integration tests.

### Hard rails (non-negotiable)

1. Tokens hashed at rest; plaintext returned once.
2. `propose_action` never auto-executes — every result is recorded with
   `autoExecuted: false` and `requiresApproval: true`.
3. Every tool call writes a `capability_provenance_nodes` row of type
   `external_agent` for full audit trail.
4. Scope strictly enforced via `scopeAllows` gating tool registration
   on the per-request `McpServer` instance.
5. Revocation is immediate (`WHERE revoked_at IS NULL`).
6. PII fields (`email`, `phone`, `password`, `token`, `secret`,
   `apiKey`, `authorization`, etc.) are recursively redacted from
   provenance payloads.

### Added — Web UX

`apps/web/public/js/pages/twin-server-tokens.js` (singleton-delegator
pattern, hash-route gated) — list active tokens, issue a new token
(shown once), revoke. Wired into the dashboard nav.

### Added — Protocol docs

`docs/twin-mcp-protocol.md` — handoff document for external-agent
integrators describing endpoint, auth, scope semantics, tool surface,
and example calls.

## [unreleased] — Capability Acquisition Loop foundation (#173)

First child of Epic #195 (Capability Acquisition Loop). Establishes the
MCP-as-capability-port and per-app autonomy primitives that the rest of
Phase 1 builds on. Companion architecture document: `docs/architecture-philosophy.md`.

### Added — `@skytwin/mcp-host`

New package implementing `IronClawAdapter` over MCP (Model Context Protocol).
Stdio + HTTP/SSE transports. Each MCP server runs under `@skytwin/core`
`CircuitBreaker`: 3 failures in 60s → status `failed`, no auto-restart loop.
Per-server resource limits (memory cap via `--max-old-space-size`, CPU/no-egress
are container-level placeholders documented for #180/#183). Best-effort rollback
via paired `*_undo` / `unsend_*` heuristics. 23 unit tests passing + 3 skipped
real-MCP-server integration tests TODO'd for follow-up commit.

### Added — `@skytwin/registry-client`

New package projecting a unified MCP server catalog. Embedded `data/curated.json`
ships 66 hand-vetted entries (15 Anthropic-verified reference servers + 51
community), distributed across 9 categories (developer, productivity, lifestyle,
data, search, media, home, finance, social). Works without internet access.
Smithery API client augments the embedded list nightly; falls back to embedded
on 5xx; rolling-1h failure window with `circuit_open` after 3 failures. 19 unit
tests passing.

`data/oauth_quirks.json` documents per-server OAuth handoff quirks for
notion, linear, slack, github, google-drive, gmail, google-calendar.

### Added — Per-app autonomy overrides

`AutonomySettings.perAppOverrides` keyed by registry id. Per-app overrides may
only narrow autonomy; the user-global cap is always the upper bound. Hard rails
(FS denylist, resource caps, audit log) are not subject to overrides.

`SpendTracker.checkDailyLimit` accepts an optional `appRegistryId`. When supplied,
the per-app cap is consulted before falling back to user-global. Rejection
messages include the per-app context for debuggability.
`resolveEffectiveCaps(settings, appRegistryId)` is exported for reuse by the
policy engine and decision pipeline. 15 new unit tests.

### Added — Migration `027-capability-acquisition.sql`

Additive only. Down-migration drops new tables in reverse FK order. New tables:
`mcp_servers`, `mcp_server_skills`, `app_suggestions`,
`capability_provenance_nodes`/`_edges`, `fs_scan_roots`, `fs_file_index`,
`capability_recipes`, `twin_briefings`, `mcp_server_metrics`, `dxt_exports`.
Per-app spend caps (`per_app_*_cents`) live on `mcp_servers` and feed the
SpendTracker per-app override path.

### Added — `MCP_HOST_TRUST_PROFILE` + boot wiring

New trust profile registered in `@skytwin/execution-router`: partial
reversibility, OAuth auth model, `riskModifier: 1`. `apps/api`'s
`createExecutionRouter()` now constructs an `McpHost` and registers it on the
`AdapterRegistry` at startup with zero servers. Servers are added via the
user-facing install flow coming in #176.

### Tests

103/103 in `@skytwin/policy-engine` (88 existing + 15 new per-app overrides).
19/19 in `@skytwin/registry-client`. 23 passing + 3 skipped in `@skytwin/mcp-host`.
Full workspace `pnpm build` green across 22 packages.

## [0.6.21.0] - 2026-05-06

Bump `electron-builder` from 24.x to 26.8.1. Supersedes Dependabot PR #65, which was held back because the version bump alone broke `electron-builder --linux/win/mac` with a config schema validation error.

### Why the dependabot bump alone failed

electron-builder v26 tightened the `linux.desktop` schema. Pre-v26, you could put any `.desktop` file key (`Name`, `Comment`, `Categories`, ...) directly under `linux.desktop`. v26 expects `linux.desktop` to be `{ desktopActions?, entry? }` — your `.desktop` file fields go under `desktop.entry`.

The CI failure surfaced as:

```
configuration.linux.desktop has an unknown property 'Name'.
configuration.linux.desktop has an unknown property 'Comment'.
configuration.linux.desktop has an unknown property 'Categories'.
```

### Fix

Move the three `.desktop` keys into `linux.desktop.entry` in `apps/desktop/package.json`:

```json
"linux": {
  "desktop": {
    "entry": {
      "Name": "SkyTwin",
      "Comment": "Your personal AI assistant",
      "Categories": "Utility;Office;"
    }
  }
}
```

Verified locally with `npx electron-builder --linux --dir` — schema validation passes, `dist-electron/linux-arm64-unpacked/` is produced cleanly.

### Tests

Backend test suite still green across 40 packages. CI's macOS/Windows/Linux desktop jobs will exercise the actual installer build.

## [0.6.20.0] - 2026-05-06

Fix three integration-live tests that fail locally when an API server is up but the web dashboard isn't — common when a sibling Conductor worktree is running its own API on `:3100` but no web server on `:3200`.

### Fixed — `apps/desktop/src/__tests__/integration-live.test.ts`

Pre-fix, every describe block was gated on a single `serverAvailable` predicate that only checked `http://localhost:3100/api/health/live`. Two blocks ("web dashboard proxy (desktop embeds this)" and "desktop service manager targets") fetched `http://localhost:3200` — so when the API was up but the web app wasn't, those blocks ran and failed instead of skipping.

Added a separate `webAvailable = isServerUp('http://localhost:3200/')` predicate. The "web dashboard proxy" block and a new "desktop service manager targets — web dashboard" block (split out of the existing service-manager block, which had one API test + one web test mixed together) gate on `webAvailable`. The pure-API "desktop service manager targets — API" block keeps `serverAvailable`.

### Fixed — `apps/mobile/src/__tests__/integration-live.test.ts`

Same shape of bug. The "web proxy (mobile browser fallback path)" describe block fetched `http://localhost:3200` but was gated on `serverAvailable` (API only). Added the same independent `webAvailable` check and gated that block on it. The `isServerUp` helper now takes a URL argument so both predicates share the implementation.

### Why CI was unaffected

CI doesn't start either server, so `serverAvailable` was false there and all describe blocks correctly skipped. The bug only surfaced on local dev machines where an API happened to be running. No CI behavior change from this PR.

### Tests

`pnpm --filter @skytwin/desktop test` and `pnpm --filter @skytwin/mobile test` both clean locally now (4 + 2 skipped, 124 + 116 passed). Backend test suite still green across 40 packages.

## [0.6.19.0] - 2026-05-06

Convert the AI provider card's nine remaining inline event handlers to data-action delegation. Pairs with v0.6.18.0 — together they close the last CLAUDE.md "no inline handlers" violations in the web SPA.

### Fixed — `.ai-provider-card` had four inline drag handlers + five inline onchange

```html
<div class="ai-provider-card" draggable="true" data-idx="${idx}"
     ondragstart="aiDragStart(event, ${idx})"
     ondragover="aiDragOver(event, ${idx})"
     ondragleave="aiDragLeave(event)"
     ondrop="aiDrop(event, ${idx})"
     ...>
  <input type="checkbox" onchange="aiToggleEnabled(${idx}, this.checked)">
  <input ... onchange="aiUpdateField(${idx}, 'model', this.value)">
  <select ... onchange="aiUpdateField(${idx}, 'model', this.value)">
  <input ... onchange="aiUpdateField(${idx}, 'baseUrl', this.value)">
  <input ... onchange="aiUpdateField(${idx}, 'apiKey', this.value)">
```

Same XSS-unsafe-by-construction concern as v0.6.18.0: `idx` is a safe integer today, but the JS-string-literal-context interpolation pattern is the wrong shape.

### Fix

Removed all nine inline handlers. Card markup now uses `data-region="ai-provider-card"` (so the delegated listeners can find the card via `closest()`) and inputs carry `data-action="ai-toggle-enabled"` / `data-action="ai-update-field"` + `data-field="model"|"baseUrl"|"apiKey"`.

Two new delegated listeners hoisted into the existing `ensureSettingsListener()` singleton:

1. `change` — resolves card via closest, dispatches `ai-toggle-enabled` / `ai-update-field` to existing `window.aiToggleEnabled` / `window.aiUpdateField`
2. `dragstart` / `dragover` / `dragleave` / `drop` — resolves card via closest, dispatches to existing `window.aiDragStart` / `aiDragOver` / `aiDragLeave` / `aiDrop`

The original drag handlers used `e.currentTarget` to set inline styles (opacity, borderColor). Under delegation `currentTarget` is `document`, so the listener shadows that property on the event with the resolved card before delegating. The `window.*` function bodies are unchanged — call shape preserved verbatim.

### Tests

Backend test suite still green across 40 packages. Drag + change behavior is browser-only.

## [0.6.18.0] - 2026-05-06

Convert the last inline event handler on the Twin/learnings page to data-action delegation. Closes a CLAUDE.md violation that's been hiding in `twin.js`.

### Fixed — `twin.js` "Tell me something about yourself" form had inline onsubmit

The "Save this preference" form rendered:

```html
<form id="add-pref-form" onsubmit="return handleAddPreference(event, '${userId}')">
```

CLAUDE.md flags this pattern as **XSS-unsafe-by-construction** even when the current values (UUIDs, enums) happen to be safe today: `escapeHtml` is HTML-context safe, but the value lands inside a JS-string-literal context inside the inline handler attribute. A future caller passing user-derived input would be smuggling code, not data.

Fix: swap to `data-action="add-preference"` + `data-user-id="${escapeHtml(userId)}"` (HTML attribute context, safe), then add a delegated `submit` listener to the existing `_twinInsightWired` singleton block. The listener checks `data-action`, reads `userId` from `data-user-id`, and calls the existing `window.handleAddPreference(event, userId)` — call shape preserved verbatim so the function body doesn't need to change.

The settings.js AI provider card still has 9 inline handlers (`ondragstart`, `ondragover`, `ondragleave`, `ondrop`, plus 5 `onchange`). That's the v0.6.19.0 follow-up.

### Tests

Backend test suite still green across 40 packages. Form behavior is browser-only.

## [0.6.17.0] - 2026-05-06

Two bugs in the Audit page caught during a sweep of less-touched surfaces.

### Fixed — broken Retry button on the Audit page

`renderAudit()` passed `retry: load` to `renderApiError({ context, retry })`. `load` was never defined — the function is called `loadAudit`. So when the API was down and the page rendered the friendly-error card, clicking Retry threw `ReferenceError: load is not defined` silently in the console and nothing reloaded. Renamed the call site to `retry: loadAudit`.

### Fixed — listener-stacking on every navigation back to /audit

The previous implementation wired `addEventListener('click', loadAudit)` on the Refresh button and `addEventListener('change', loadAudit)` on the filter inputs *inside* `renderAudit()`. Each navigation to /audit re-runs `renderAudit()`, which means after N visits each filter change fires `loadAudit()` N times in parallel — the same singleton-delegator pattern violation `CLAUDE.md` flags for approvals/settings/decisions/dashboard-view.

Fix: hoisted the listeners to a module-level `ensureAuditListener()` with a `_auditListenerWired` guard, attached on `document`, gated by `window.location.hash` (not DOM containment, since the SPA reuses one `#page-content` element across routes). Filter inputs and the Refresh button moved to `data-action` / `data-region` attributes so the delegator can identify them.

`loadAudit()` reads `_auditUserId` from module scope (set in `renderAudit()`) — same pattern as approvals.js's `_approvalsUserId`. Defends against the dev "Switch user" scenario where a closure over a render-time userId would fire under the wrong account.

### Tests

Backend test suite still green across 40 packages. Audit page is browser-only.

## [0.6.16.0] - 2026-05-06

Make the chat thread delete recoverable. Pre-fix, clicking the X next to a thread title fired the DELETE immediately with no confirm and no undo — risky for non-technical users on small screens where the X sits 8px from the thread title.

### Added — toast `action: { label, onClick }` option

`showToast(msg, { ..., action: { label: 'Undo', onClick: fn } })` renders a pill-shaped action button between the message and the close X. Clicking the action runs `onClick` then dismisses; clicking elsewhere on the toast still dismisses without firing the action. The signature matches the comment hint we left in `toast.js` v0.6.8.0 ("if we ever add action buttons to toasts in the future").

CSS is namespaced `.skytoast-action` — outline-style accent pill so it reads distinct from the close X.

### Changed — `handleDeleteThread` is now soft-delete with undo

Click X → optimistic UI removal + 6s undo toast. If the user clicks Undo, the timer is canceled and the thread restores without ever hitting the server. If 6s elapses, the real `deleteAssistantThread` API call fires.

State preserved during the undo window:
- `previousThreads` slice for full rollback
- `previousMessages` slice when the active thread itself was the one being deleted (restoring the active thread restores the full chat history mid-undo, no fetch needed)
- Pending timers tracked in `_pendingDeletes: Map<threadId, timeoutHandle>` so a misclicked X followed by another misclick on the same thread is a no-op (the second click sees a pending entry and bails)

If the active thread was the one deleted, the next-most-recent thread becomes active during the undo window and its messages are fetched async — so the chat pane shows something instead of going blank for 6 seconds.

### Tests

Backend test suite still green across 40 packages. Undo behavior is browser-only.

## [0.6.15.0] - 2026-05-06

Stop yanking the user back to the bottom of the chat while they're scrolled up reading history.

### Fixed — chunk-by-chunk streaming forced `scrollTop = scrollHeight` on every token

Prior behavior: open a long thread, scroll up to re-read an earlier assistant reply, send a new prompt → every chunk that lands snaps the scroll back to the bottom mid-token. Reading history during a streaming response was effectively impossible.

New behavior: `maybeAutoScroll(container)` only follows the stream when the messages region was already within `NEAR_BOTTOM_THRESHOLD_PX` (80px) of the bottom. If the user has scrolled up, the chunks accumulate quietly off-screen and they keep reading what they were reading.

### Added — "↓ Jump to latest" floating pill

Sits absolutely-positioned over the chat pane, above the composer. Hidden via the `hidden` attribute when the user is at the bottom; revealed when they scroll away. Click → smooth jump to the live tail. Drives off the same `isNearBottom()` predicate that gates auto-scroll, so the two behaviors always agree.

The scroll listener is delegated on `document` with capture phase (scroll events don't bubble by default, so capture is required to see them from the inner pane). The jump button uses the existing `data-action="jump-latest"` delegation pattern.

### Tests

Backend test suite still green across 40 packages. Scroll behavior is browser-only.

## [0.6.14.0] - 2026-05-06

Mobile fix for the assistant chat: composer no longer disappears behind the soft keyboard.

### Fixed — `vh` → `dvh` on `.assistant-shell` height

The chat shell sized itself with `height: calc(100vh - 12rem)`. On mobile, `vh` is fixed to the *visual* viewport height as the page first paints — it doesn't shrink when the keyboard appears. Result: tap the composer, keyboard slides up, the composer slides up with it but the parent shell still thinks it has full-viewport height, so the composer ends up rendered behind the keyboard. The user can't see what they're typing.

`dvh` (dynamic viewport height, stable in all evergreen browsers since 2022) shrinks with the keyboard so the composer stays visible. Both the desktop default and the `<= 768px` breakpoint update; the `vh` line stays above the `dvh` line as a fallback for older browsers (last-rule-wins, so `dvh` wins where supported).

### Tests

CSS-only change. Backend test suite still green across 40 packages.

## [0.6.13.0] - 2026-05-06

Bump `electron-store` from 8.x to 11.x. Supersedes Dependabot PR #71, which was held back because the bump alone broke `tsc` on `apps/desktop/src/window-state.ts`.

### Why it broke

electron-store v9 became ESM-only and started extending the (also ESM-only) `Conf` class for its `.get` / `.set` API. The desktop app's `tsconfig.json` uses `module: commonjs`, so under that resolution mode TypeScript can't follow the inheritance chain across the ESM boundary — it sees `ElectronStore<T>` as a class with no methods, even though `.get` / `.set` exist on the parent at runtime.

At runtime this is fine: Electron 41 ships Node 22.14, which supports `require()` of ESM modules natively (stable since Node 22.12).

### Fix

Narrow the constructor result to a small structural surface that matches the three call sites we actually use (`get('windowBounds')`, `set('windowBounds', …)`, `set('windowBounds.isMaximized', …)`) via `as unknown as WindowBoundsStore`. Easier to audit than a blanket `any`, and the constructor signature + runtime call sites stay unchanged so a future ESM migration of `apps/desktop/tsconfig.json` can drop the cast cleanly.

### Tests

Backend test suite still green across 40 packages. `pnpm tsc --noEmit` clean in `apps/desktop`. Pre-existing 3 failures in `integration-live.test.ts` (require localhost:3200 to be running) are unaffected.

## [0.6.12.0] - 2026-05-05

Two assistant composer polish items the dashboard "Ask your twin" widget already had — bring the chat surface up to parity.

### Added — `Enter` / `Shift+Enter` keyboard hint under the chat composer

The dashboard "Ask your twin" widget surfaces this convention with a small `<kbd>` hint underneath. The chat composer was missing it, so a non-technical user would either guess (and accidentally newline when they meant to send) or never know newlines were available. New `.assistant-composer-hint` block mirrors the dashboard pattern.

### Added — composer draft persists across navigation per thread

A user who pops to `/approvals` to look something up before finishing a prompt now keeps their half-typed text. Storage is `sessionStorage` (not localStorage) — drafts are inherently transient and shouldn't leak across browser sessions. Keying:

- One bucket per thread via `assistantDraftKey(threadId)` in `apps/web/public/js/storage-keys.js`
- Brand-new threads write to the `'new'` bucket; on first send the thread ID lands and subsequent edits flow into the new bucket
- Draft is restored in `paint()` after `innerHTML` is set, with cursor at end so a quick edit ("…and tell me why") flows
- Draft is cleared on send (after the optimistic user bubble lands)

The save is wired through a delegated `input` listener on `document` (same pattern as the click and keydown delegators on this page); each keystroke is one `sessionStorage.setItem` of <few KB, well within the budget.

### Tests

Backend test suite still green across 40 packages. Composer behavior is browser-only.

## [0.6.11.0] - 2026-05-05

Adds a Stop button to the assistant chat so users can interrupt a long generation. Pre-fix the only escape was navigating away — which left the request hanging server-side and lost any partial content the user could already see.

### Added — `Stop` button replaces `Send` while streaming

- `sendAssistantMessageStream(...)` in `apps/web/public/js/api-client.js` now accepts an optional `{ signal }` so the caller can pass an `AbortSignal`. AbortError is surfaced verbatim (not wrapped in the friendly "Unable to reach the server" fallback) so callers can branch on `err.name`. The SSE read loop also rethrows AbortError instead of the generic transport-error path.
- `apps/web/public/js/pages/assistant.js` creates a fresh `AbortController` per send, stores it on `_state.streamController`, and renders a Stop button with a square-stop glyph in place of Send while `_state.sending` is true. Click → `controller.abort()` → fetch unwinds → handleSend's catch sees `AbortError` and **keeps whatever streamed so far as a real assistant bubble** (not an error caveat). The user gets to keep what they got.
- The `_state.streamController` is cleared in the finally block, gated on identity check (`=== controller`) to defend against a hypothetical race even though `handleSend` already bails early when `_state.sending` is true.

### CSS

`.assistant-composer-stop` keeps the same dimensions as `.assistant-composer-send` so the button swap doesn't shift the composer layout. Calm bg-card background instead of the action-accent — the affordance is "interrupt", not "go." A solid square ::before glyph reads before the word "Stop" does.

### Tests

Backend test suite still green across 40 packages. Stop-button behavior is browser-only.

## [0.6.10.0] - 2026-05-05

Adds suggested-prompt chips to the assistant empty state. The chat is now SkyTwin's headline surface for non-technical users, but landing on it with no conversation history shows only a generic "Ask anything" hint — paralyzingly open for a user who doesn't yet have a model of what their twin can do.

### Added — four clickable suggestion chips on `/assistant` empty state

- "What did you handle today?"
- "What's waiting for my OK?"
- "What have you learned about me so far?"
- "Archive promotional emails from last week"

Click → fills the composer and focuses the input with cursor at end. **Does not auto-send** — the chip is a starting point, not a commitment, so the user can edit before hitting Enter. Same `data-action` delegation pattern the page already uses for `select-thread` / `delete-thread`.

The chips cover three "show me what's going on" prompts (read-only; safe first contact) plus one action-routing example so the user discovers chat can also queue actions for approval. The action-routing intent flows through the `intentRoute` pipeline that landed in v0.6.4.0 (#148 v1), so a click → edit → send already lands on the approvals page.

### CSS

`.assistant-suggestions` flex-wraps the pill-shaped chips below the empty-state copy. Restored `opacity: 1` on the container because the parent `.assistant-empty` dims its prose to 0.75 — without the override the chips would read as disabled. Hover lifts the chip 1px and tints the border to the accent color; respects `prefers-reduced-motion`.

### Tests

Backend test suite still green across 40 packages. Empty-state UI is browser-only.

## [0.6.9.0] - 2026-05-05

Toast cleanup + back-online affordance. Closes the "migrate legacy `.toast` callers" item that was deferred in v0.6.8.0 so the duplicate CSS can come out, and adds a back-online toast so the user gets explicit confirmation when the API recovers (instead of having to notice the banner disappear).

### Changed — three pages migrated from raw `.toast` DOM to `showToast()`

- `apps/web/public/js/pages/decisions.js` — the "Walked back" success toast (with quoted reason) and the "Couldn't walk that back" error toast now use `showToast(msg, { kind })`. Both use a 4s duration to give the user time to read the quoted reason.
- `apps/web/public/js/pages/twin.js` — the "Got it, I'll remember that" / "Removed" correction toast.
- `apps/web/public/js/pages/approvals.js` — removed the local 12-line `showToast(message, type)` helper (manual `requestAnimationFrame` + `.visible` toggle + nested `setTimeout`); the three call sites — escalation choice, escalation custom-text, and approve/reject — now use the shared `showToast(msg, { kind: 'success' })`.

Net: −33 lines of per-file DOM toast plumbing; toast behavior now consistent across pages (same animation, same dismiss-on-click, same hover-to-pause, same screen-reader announcement).

### Added — back-online toast on connection recovery

`updateConnectionStatus()` in `apps/web/public/js/app.js` now edge-triggers a `showToast('Back online — SkyTwin is listening again.', { kind: 'success' })` when transitioning from offline → online (either SSE reconnect or a successful health check after a failure). Skips the very first call after page load (no prior offline state to "recover" from) by initializing `_wasOffline = null` rather than `false`. Without this, the user has to notice the disconnect banner disappear — easy to miss when the banner is the only signal. The toast complements the banner by surfacing the recovery actively.

### Removed — legacy `.toast` CSS block

Deleted the `.toast`, `.toast.visible`, `.toast-success`, `.toast-error` rules at the previous line 745 of `apps/web/public/css/styles.css`. With all callers migrated, those classes are dead code. Updated the explanatory comment on the `.skytoast-*` block to note the migration completed in this version. Note: `apps/web/public/js/sse-client.js` has its own internal `showToast(title, message, type)` for SSE notifications using inline styles (not the `.toast` class), so it's unaffected.

### Tests

Backend test suite still green across 40 packages (212 passed in @skytwin/api alone, plus 104 in ironclaw-adapter). Toast component is browser-only; no new unit tests.

## [0.6.8.0] - 2026-05-05

Closes UX review #10 — adds reusable toast notifications + Settings auto-save. The toast component is the reusable infrastructure piece several deferred findings were waiting on.

### Added — `apps/web/public/js/toast.js` (new module)

`showToast(message, { kind, durationMs })` — bottom-right toast stack with four kinds (success / info / warning / danger), each color-coded via theme variables. Auto-dismiss after 3.5s (success/info) or 6s (warning/danger), but pauses on hover so the user can read longer. Click anywhere on the toast to dismiss early. `aria-live="polite"` on the stack so screen readers announce messages without stealing focus. Respects `prefers-reduced-motion` (slide-in animation no-ops). `durationMs: 0` makes a toast sticky.

Convenience wrappers: `showSavedToast()` and `showErrorToast(message)`.

CSS classes are namespaced `.skytoast-*` to avoid colliding with the legacy `.toast` rules used by approvals.js / decisions.js / twin.js for inline "Saved" indicators. Eventually those callers can migrate to `showToast()` and the legacy CSS can come out.

### Changed — Settings auto-saves the autonomy tier and spending guardrails

- **Tier auto-save** — selecting a different "How much should your twin do?" option auto-saves 800ms after the click (long enough that mis-clicks don't ping the server, short enough to feel responsive). Save button still works for users who prefer the explicit affordance.
- **Spending guardrails auto-save** — typing in the per-action / per-day caps OR toggling "Always ask before doing something that can't be undone" auto-saves 1.2s after the last edit (slightly slower debounce because the user is typing into a number field). Skips if either field is mid-edit (NaN).
- Both end with a "Saved ✓" toast. Failures show the centralized friendly error message.

### Tests

No new unit tests — toast + auto-save are browser-only. Backend test suite still green across 40 packages. Visual verification screenshots in `.context/ux-review/30-toasts-working.png` and `31-toasts-styled.png`.

### What's left from FINDINGS.md

- **Hosted OAuth deployment** (#1, infra)
- **More Advanced section consolidation** (#8 follow-up)
- **Onboarding step count audit** (#14, needs product input)
- **Migrate legacy `.toast` callers** to the new `showToast()` API so the duplicate CSS comes out (cleanup, low priority)

## [0.6.7.0] - 2026-05-05

Last batch from the browser-agent review. Closes the remaining tractable items: hosted-OAuth code support (the unblocker for "everyone can use it") and Settings cleanup. The actual hosted Google OAuth app verification is still infra work outside this repo.

### Added — hosted OAuth code path (UX review #1 P0 — code support shipped)

- **`/api/credentials/status` now returns `google.hosted: boolean`** — set true when `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` env vars are wired (the operator-supplied hosted-OAuth case). Distinguishes from `google.configured` which is true for either hosted OR user-supplied DB credentials.
- **Setup page short-circuits the GCP walkthrough when hosted is true.** Pre-fix, every install asked the user to walk through Google Cloud Console (~95% of non-technical users would not complete this). Now: when the operator ships hosted credentials via env vars, the Setup page collapses to a small "Your SkyTwin install includes Google access — no developer setup needed. Open Settings → Connected accounts and click **Connect**." card with a one-click link.
- **No application code change needed for operators** — set the env vars on the deploy and the BYO walkthrough disappears. The actual hosted SaaS deploy still needs a Google-verified OAuth app (separate infra work), but the application is now ready to receive those credentials.

### Fixed — Settings: dev-only "switch user" gated behind `?dev=1` (P1 #8)

- Pre-fix the Settings page had 5 collapsed "Advanced —" sections, signaling "this app has a lot of hidden complexity" to a non-technical user. The "Advanced — switch user (developer)" section is dev-only — used while standing up multiple test accounts on the same machine; no end user needs it.
- Now: gated behind `?dev=1` query string. Default Settings view drops to 4 disclosure sections instead of 5; the dev workflow is unchanged (`?dev=1` is sticky in the URL bar for devs who want it).

### Tests

No new unit tests — every change is in browser-only code OR the credentials route response shape (covered indirectly by the existing credentials-routes integration tests). Backend test suite still green across 40 packages.

### What's still open from FINDINGS.md

- **Hosted OAuth (P0 #1)** — code path now ships in this PR. Final step is creating the verified Google OAuth app + production hosting. Not a code change, infra/operations work.
- **Auto-save with toast (P1 #10)** — needs a toast component first.
- **More "Advanced —" consolidation** — execution routing + domain overrides + escalation triggers are advanced but legitimately user-facing; consolidating them needs a small refactor of the disclosure pattern.
- **Onboarding step count audit (P1 #14)** — see if any of the 5 onboarding steps can be optional-after-onboard. Needs product input.

## [0.6.6.0] - 2026-05-05

UX polish — second wave from the same browser-agent visual review that produced #154. Picks up the P1/P2 findings that were deferred from the hardening pass: Settings cleanup, theme switcher relocation, console-spam reduction, date input theming, onboarding modal dimmer, Chat → Settings deep-link.

### Fixed — Settings page is more honest about what's required and where things live

- **Theme switcher relocated to Settings (P1 #7).** Pre-fix the theme picker pill (`🌑 Quiet Confidence ▼`) sat on every page header next to the page title, where it looked like a breadcrumb / tag rather than a clickable control. Now lives in a dedicated **"Visual theme"** card in Settings with the description "Pick how the dashboard looks. Changes apply immediately." The header is back to just the page title + user badge.
- **"AI brain — needed for Chat (optional otherwise)" (P1 #9).** Pre-fix this section was titled "Add a smarter AI brain (optional)" — but if you visit `#/assistant` the API returns 409 "No AI provider configured." The "(optional)" was lying. Now the title surfaces the dependency, and when no providers are configured the body explicitly says "**The Chat surface needs at least one AI provider configured here** to generate replies."

### Fixed — Chat deep-links to Settings when no provider is configured (P1 #9)

- The Chat page used to render the raw "No AI provider configured" message in a bubble with no path forward. Now: when the assistant route returns a `bad-request` ApiError mentioning "provider", the chat shows "I need an AI provider configured before I can chat. Open Settings → AI brain to add one." with a deep-link footer ("Open Settings → AI brain →") that hash-routes to `#/settings`.

### Fixed — onboarding modal dimmer (P2 #15)

- Pre-fix the sidebar bled through the onboarding modal at ~25% visible (modal overlay was `rgba(0,0,0,.85)` but the sidebar has its own glass effect that survived). Drew the eye and read as "stuff I could click but can't." Bumped overlay to `rgba(0,0,0,.92)` + a `backdrop-filter: blur(4px)` so anything behind the modal is properly muted.

### Fixed — console-error spam when API is offline (P2 #20)

- Pre-fix, with the API down, the web client produced 110+ console errors per minute (every 10s badge poll, every SSE reconnect, every health check). New `isApiKnownOffline()` exported from `api-client.js`: any failed fetch with `kind: 'offline'` flips the flag; any successful fetch flips it back.
- The badge-poll loop in `app.js` now backs off from 10s → 60s when the flag is set. The connection banner already tells the user the API is offline; aggressive polling adds noise without information.

### Fixed — date input theming on Audit page (P1 #11)

- Pre-fix the audit-trail filters used raw `<input type="date">` with the OS-default styling (gray box, mm/dd/yyyy placeholder), which clashed with the dark glass aesthetic everywhere else.
- New `.themed-date` class matches the rest of the form-input styling, with `color-scheme: dark light` so the native picker icon uses light glyphs on dark themes (vs. invisible dark-on-dark). Webkit-specific `::-webkit-calendar-picker-indicator` filter gets the icon to read at high enough contrast.

### Tests

No new unit tests — every change is in browser-only code. Verified via the same browser-agent visual review (`.context/ux-review/20-23-` screenshots show the after state). Full backend test suite still green across 40 packages.

### What's still open from the UX review

- **Hosted OAuth (P0 #1)** — needs verified Google OAuth app + production hosting. Tracked separately.
- **Settings consolidate "Advanced" sections (P1 #8)** — the page now has 5 collapsed Advanced sections; consolidating them needs a small refactor of the Advanced-anything pattern.
- **Auto-save with toast (P1 #10)** — needs a toast notification component. Skipped for scope.
- **Bare connection-status footer text** vs. the new banner — they're now redundant; one of them can come out.

## [0.6.5.0] - 2026-05-05

UX hardening pass driven by a browser-agent visual review of every SPA route — focused on what would confuse a non-technical user. 7 of the 20 findings closed in this PR (the load-bearing ones); polish items deferred to a follow-up. See `.context/ux-review/FINDINGS.md` for the full list with severity grades.

### Fixed — what a first-time user sees when something goes wrong

- **Centralized friendly errors in `api-client.js` (P0 #4).** New `ApiError` class with `kind` discriminant (`offline | auth | not-found | bad-request | server | unknown`) and a `friendlyMessage` field. The web dev proxy returns `{error: 'API proxy error'}` when the upstream API is down — pre-fix, that string leaked verbatim to users on Chat / Decisions / Audit pages. Now translated to "Can't reach SkyTwin right now. We'll keep trying." `renderApiError(err, { context, retry })` and `wireApiRetry(container, retry)` give every page the same calm error card with a "Try again" button.
- **Approvals + Decisions + Audit + Chat use the centralized helper (P0 #5).** Pre-fix, Approvals showed "0 waiting / You're all caught up" when the API was down — indistinguishable from genuinely having nothing to do, so a user could miss real approvals. Now: a loaded-empty list looks different from an offline list, and Try again is one click away.
- **UUID badge → friendly fallback (P0 #2).** Header user badge and Settings footer used to show the raw UUID `11111111-2222-…` when the user record couldn't be loaded. Now shows `You (1111…)` with the first 4 chars of the userId in a tooltip for devs.

### Fixed — connection status

- **Promoted "Reconnecting…" from the bottom-left footer to a header banner (P1 #12).** Calm yellow banner with an animated dot + "Retry now" button, rendered below the page header on every page when the API is unreachable. Hidden when connected so it doesn't take vertical space on the happy path. The footer indicator stays as a secondary signal.
- Banner respects `prefers-reduced-motion`.

### Fixed — onboarding step 1 has working examples even when the API is down

- **Demo preview card static fallback (P1 #6).** Pre-fix, the "Try one — see how it thinks" card was rendered with `display: none` and only revealed by JS after a successful `/api/v1/demo/info`. With the API down, the card never appeared — the WHOLE POINT of step 1 (let me show you how it thinks before you sign up) had no interactive affordance. Now the card always renders; if the live preview is unavailable, clicks return pre-canned sample answers (recruiter / subscription / dinner) with the same visual treatment as the live engine, plus a small "Live preview offline — showing a sample answer" caveat.

### Fixed — mobile

- **Mobile bottom-nav with real icons (P0 #3).** Pre-fix had single-letter icons (H/!/D/T/S) that were mysterious to first-time users. Replaced with inline-SVG icons (home/chat-bubble/checkmark-circle/hamburger/gear).
- **Chat link added to mobile bottom-nav.** v0.6.0.0 shipped the Chat feature in the desktop sidebar but missed the mobile nav entirely — feature was unreachable on phones.
- **Bottom-nav no longer overlaps page content.** Increased `.content` `padding-bottom` from `4rem` to `5.5rem + safe-area-inset` so the last interactive element on every page (composer hint, Save button, etc.) isn't hidden under the nav.

### Fixed — voice

- **Sidebar "My learnings" → "What I've learned" (P1 #13).** Sidebar label now matches the page header. Route title in `app.js` updated.

### Tests

No new unit tests in this PR — every change is in browser-only code (`apps/web/public/js/*`, CSS, HTML). Verified with the same browser-agent visual review (`.context/ux-review/14-` through `19-` screenshots show the after state). Full backend test suite still green across 40 packages.

### What's still open from the UX review

- **Hosted OAuth (P0 #1)** — single biggest unblocker for "everyone can use it" goal. Requires a verified Google OAuth app + production hosting; can't ship from a worktree alone.
- **Settings consolidation, theme switcher relocation, "needed for Chat" hint, auto-save, date input theming, onboarding sidebar dimmer (P1 #7-#11, #15)** — queued for a follow-up "Settings + Connect polish" PR.

## [0.6.4.0] - 2026-05-05

Closes issue #148 v1 — assistant phase 2c. The chat surface now routes detected action intents through the existing decision pipeline instead of just talking about them. Saying "archive that email" or "schedule a meeting with X" in chat creates an `ApprovalRequest` and queues it on the existing `#/approvals` page. Conversational messages still go through the LLM chat path unchanged.

This is the **last phase-2 item** for the assistant epic. Phase 2 is now complete: streaming (#146), context (#147), multi-turn API (#149), action routing (#148).

### Conservative v1 design choice — read this before extending

**Chat-driven actions ALWAYS land in approvals, never auto-execute.** Even when `DecisionMaker.evaluate()` returns `autoExecute=true` (the user has high trust tier, the action is reversible, etc.), the chat router collapses that to `requiresApproval=true` for v1. Reasoning:

- Chat is a free-text channel. An unintended intent match (regex firing on a message ABOUT scheduling instead of asking to schedule) cannot trigger a real send / spend / modify. The events route has structured signals as ground truth; chat doesn't.
- The user already has the `#/approvals` UI for review and consent. Routing through it preserves the audit trail and feedback loop unchanged.
- Phase 2 of #148 lifts this restriction once we have an LLM-classifier confidence score AND an explicit per-user opt-in.

**Safety Invariants — all upheld:**
- **#1** (no auto-exec without policy check): every chat-driven action goes through `DecisionMaker.evaluate()` → `PolicyEvaluator.evaluate()`. No bypass.
- **#2** (always log explanations): `ExplanationGenerator.generate()` runs and persists for every chat-driven decision. Failure to persist logs but doesn't abort (audit-trail loss is recoverable; aborting the user's request is not).
- **#3** (respect trust tiers): trust tier comes from the user record, never from the chat input.
- **#4** (spend limits are hard): inherited from `DecisionMaker` — no special-casing for chat.
- **#5** (reversible is honest): inherited from candidate generation.
- **#7** (every action has a RiskAssessment): inherited from `DecisionMaker.evaluate()`.

### Added — rule-based intent classifier in `@skytwin/assistant`

`detectIntent(message): ActionIntent | null`. Pure regex/keyword matching for a small vocabulary:

| Intent | Pattern | Maps to |
|---|---|---|
| `archive_email` | "archive that/this/the/it" | `email_triage` |
| `label_email` | "label/tag that as X" (captures label) | `email_triage` |
| `send_reply` | "reply to / respond to / send a reply" | `email_triage` |
| `create_event` | "schedule/book/set up a meeting/call" | `calendar_invite` |
| `decline_event` | "decline/skip/cancel that meeting" | `calendar_update` |
| `create_task` | "remind me to / add a task to" | `task_management` |

- Returns `null` for messages shorter than 8 chars (avoids surprise approvals from "ok" / "thanks").
- Returns `null` for non-string input (defensive).
- Returns `null` for meta-discussion patterns ("how do you decide when to schedule things?") — false-positive guard.
- Tested with both positive matches AND false-positive guards. The latter is the load-bearing test surface.

### Added — `ActionRouter` port + `AssistantService.routeIntent`

- New `ActionRouter` interface in `@skytwin/assistant`; the route adapter satisfies it. Keeps the assistant package free of `@skytwin/decision-engine` and `@skytwin/db` deps.
- `AssistantService.routeIntent(userId, message)` runs the classifier and (if a match) calls the router. Returns `null` to fall through to the LLM chat path. Router throws are caught and downgraded to `null` — graceful degradation when the decision engine is offline.
- Three terminal outcomes (`requires-approval` / `blocked` / `no-action`); `no-action` falls back to LLM chat.

### Wiring — `apps/api/src/routes/assistant.ts`

- `buildActionRouter()` factory constructs the same TwinService + PolicyEvaluator + DecisionMaker stack `events.ts` uses. Reuses the issue #122 `LabelInferencePort` so chat-driven `label_email` candidates get the same learned-from-history confidence boost.
- Synthetic `DecisionObject` with a `chat_intent_<id>` ID; rawData includes `triggerMessage` so the approval card can show what the user said.
- Persists `ApprovalRequest` via `approvalRepository.create` — same shape as the events path. `accessToken` and `rawData` filtered from `parameters` (don't round-trip secrets through the approval payload).
- Emits `approval:new` SSE event on `sseManager` so the existing approvals badge updates immediately when a chat creates an approval.
- `POST /api/assistant/messages` branches on intent BEFORE the LLM call. If routed, persists a structured assistant message with `metadata.intentRoute` carrying the outcome kind. Both sync JSON and SSE response shapes work — SSE flushes `thread` + `user` + `done` in one shot (no chunk events because no streaming text was generated).

### Web — action footer

- `pages/assistant.js:renderMessages` checks `m.metadata.intentRoute` and renders a footer under the bubble: "Open approval →" link (hash route to `#/approvals`) for `requires-approval`; muted "Action blocked by your safety policy" notice for `blocked`.
- `assistant.css` — small accent-colored footer + link styles that respect the existing theme variables.
- Empty-state copy updated: "I can also queue actions for your approval — try 'archive that email' or 'schedule a meeting with X'."

### Tests (16 new)

- `packages/assistant/src/__tests__/intent-classifier.test.ts` (12): every intent verb + variant; label-name capture; trim + non-string defensives; **false-positive guards** (meta-discussion, action verbs as nouns); rawData source-marking; trigger-message preservation.
- `packages/assistant/src/__tests__/assistant-service.test.ts` (+4): routeIntent returns null without router; returns null when no intent matches; routes detected intents through the port; downgrades router throws to null.

### Out of scope (phase 2 of #148, future)

- **Auto-execution from chat** — when a chat-driven intent has high enough engine confidence + user trust, skip the approval step. Needs an LLM-classifier confidence score AND a per-user opt-in setting first.
- **Inline approve/reject buttons in chat** — instead of a "Open approval" link, render the approve/reject UI directly in the assistant bubble. Bigger UX surface; deferred.
- **Thumbs up/down feedback wired to twin model** (Safety Invariant #6 follow-up specific to the assistant) — events-path feedback already wires through; chat-path feedback is separate.
- **LLM-based intent classification** for ambiguous or paraphrased intents the regex doesn't match. Adds cost + latency to every chat turn; deferred until the rule-based vocabulary proves insufficient.
- **Multi-step plans** ("first do X, then Y if Z") — out of scope per the original issue body.

## [0.6.3.0] - 2026-05-05

Closes issue #149 — `LlmClient.generate` and `generateStream` now accept `string | ChatMessage[]`. Each provider translates the array to its native chat-completion format. The `User:` / `Assistant:` prompt-flattening workaround in `@skytwin/assistant` is gone — `reply()` and `replyStream()` pass the conversation history directly. Pure refactor: no new user-visible feature, but unblocks #148 (action-intent routing) and removes the comment-laden workaround that's been load-bearing since assistant phase 1.

Backward-compatible: existing string callers (decision-engine's LLM strategies, every provider integration test, anything outside this monorepo that imports `@skytwin/llm-client`) work unchanged.

### Added — `ChatMessage` type + helpers in `@skytwin/llm-client`

- `ChatMessage = { role: 'system' | 'user' | 'assistant', content: string }` re-exported from package root.
- `toMessages(input: string | ChatMessage[]): ChatMessage[]` — wraps a string as one user-role message; passes arrays through unchanged. Pure function used by every provider.
- `splitSystemAndConversation(messages, fallbackSystem?)` — peels system messages out of the array and joins them with `\n\n`. Lets providers like Anthropic and Gemini that take `system` as a top-level field separate from the conversation array do that translation in two lines instead of N. Inline system messages WIN over `options.systemPrompt` so the assistant package's context block (injected as a system turn) is never silently overridden by the route's default prompt.

### Changed — `LlmClient.generate` + `generateStream` signatures

- `prompt: string` → `prompt: string | ChatMessage[]`. String input behaves exactly as before (provider chain still emits `chunk` and `done` events for the streaming path identically; `generate` returns the same `LlmResponse` shape).

### Changed — providers translate to their native chat-completion shapes

| Provider | Before | After |
|---|---|---|
| **Anthropic** | `messages: [{role: 'user', content: <prompt>}]` + `system` top-level | Pass-through `messages` array; system-role messages hoisted to the `system` field via `splitSystemAndConversation` |
| **OpenAI** | Hardcoded system + user pair | Pass-through `messages` array; falls back to `options.systemPrompt` only when no inline system message exists |
| **Google/Gemini** | Fake `user: <prompt>` + `model: "Understood."` pair to emulate system | Native `system_instruction` field; assistant role correctly translated to `'model'` (Gemini's vocabulary). Saves tokens AND removes a drift hazard |
| **Ollama** | `/api/generate` with `systemPrompt + "\n\n" + prompt` flattened | Switched to `/api/chat` with native `messages: [{role, content}]` array. Both endpoints exist on every modern Ollama server; the chat one matches what every other provider in the chain uses. Response parsing also moved from `{response}` to `{message: {content}}` |

### Changed — `AssistantService` drops the role-flattening workaround

- `reply()` and `replyStream()` now pass the trimmed `ChatTurn[]` directly to `LlmClient.generate` / `generateStream`. `ChatTurn` and `ChatMessage` are structurally identical, so the change is just dropping the call to `formatHistoryAsPrompt`.
- New private `composeSystemPrompt(enrichment?)` helper shared between `reply()` and `replyStream()` so the two paths cannot drift on the prepend-context-block step.
- `formatHistoryAsPrompt` stays exported for back-compat (no known external callers, but the function was public; plan to remove on the next major bump if no consumers surface).

### Tests (28 new)

- `packages/llm-client/src/__tests__/messages.test.ts` (7): `toMessages` string-wrapping + array-passthrough; `splitSystemAndConversation` joining, fallback semantics, inline-wins-over-fallback, all-system input.
- `packages/llm-client/src/__tests__/provider-multiturn.test.ts` (15): per-provider request-body shape assertions for both string and `ChatMessage[]` inputs. Anthropic system-hoisting + inline-wins. OpenAI no-duplicate-system. Gemini role translation + native `system_instruction` (no fake user/model pair) + omit-when-empty. Ollama `/api/chat` endpoint switch + response shape change + empty-response defensive return.
- `packages/assistant/src/__tests__/assistant-service.test.ts` (1 updated): the history-cap test now asserts against the messages array's content fields instead of the flattened prompt string. Same intent, post-#149 wire format.

### Out of scope for this PR (last remaining phase 2 work)

- #148 action-intent routing through `@skytwin/decision-engine` — unblocked by this PR. The intent classifier can now look at structured turns instead of regexing a flattened prompt.

### Migration notes

No caller-facing changes for back-compat string passers. New callers can drop history-flattening logic; pass `ChatMessage[]` instead. Decision-engine LLM strategies (LlmCandidateGenerator, LlmSituationStrategy) were not migrated in this PR — their `PromptBuilder`-built prompts work as-is, and changing them would conflate this refactor with their own re-shaping.

## [0.6.2.0] - 2026-05-05

Closes issue #146 — assistant phase 2a. The chat UI now streams replies token-by-token instead of blocking on the full LLM response. Anthropic ships native SSE; the other providers fall back to single-chunk emission so the API contract is uniform regardless of which provider is in front. Backward-compatible: legacy JSON callers still work unchanged.

### Added — streaming through the LLM client

- **`LlmClient.generateStream(prompt, options)`** returns an `AsyncIterable<LlmStreamEvent>`. Yields `{ type: 'chunk', content }` per token, then exactly one `{ type: 'done', content, provider, model, latencyMs }` at the end.
- **Provider-chain semantics for streaming:**
  - **Pre-first-chunk failures fall through** to the next provider, just like sync `generate()`. If every provider fails before yielding any text, throws `AllProvidersFailedError` with the same `attempted` array as the sync path.
  - **Mid-stream failures do NOT fall through.** Once a provider has committed by yielding even one chunk, the caller (and the user's eyes) have already received text — silently re-trying a different provider would produce duplicate output. The error re-throws so the route can surface a partial-reply notification.
- **Native Anthropic streaming** in `packages/llm-client/src/providers/anthropic.ts:streamGenerate`. Real SSE consumption of the `/v1/messages` endpoint with `stream: true`. Buffers events across `reader.read()` boundaries (a chunk can split mid-event). Tolerates the full Anthropic event taxonomy by ignoring everything except `content_block_delta` events with `delta.type === 'text_delta'` — `message_start`, `ping`, `content_block_start`, `message_stop` are all benign.
- **Universal fallback for non-streaming providers** (`makeFallbackStream` in `llm-client.ts`) — wraps the existing sync `generate` as a single-chunk async iterable so OpenAI / Google / Ollama get the same caller contract without a real streaming implementation. Adding native streaming for those providers is just dropping a new `streamGenerate` into their provider module — no changes elsewhere.

### Added — `AssistantService.replyStream`

- Streaming variant of `reply()` returning `AsyncIterable<AssistantStreamEvent>`. Yields `chunk` events as text arrives, then exactly one terminal event:
  - `done` (success) — assembled `fullContent` + `metadata`
  - `error` (mid-stream failure with at least one chunk landed) — `partialContent` + `message`
  - Pre-first-chunk failures escape via throw (caller turns into HTTP 502 — same as sync path)
- Same `EnrichmentRequest` semantics as `reply()` — when supplied AND a `ContextBuilder` is wired, the rendered twin/memory context block is prepended to the system prompt for this request.

### Added — SSE response on `POST /api/assistant/messages`

- The route now branches on the `Accept` header. `text/event-stream` triggers the streaming path; everything else falls through to the existing sync JSON response.
- **Wire format** (each event is `event:` + `data:` + blank line):
  ```
  event: thread\ndata: {"id":"…","isNew":true}
  event: user\ndata: {…userMessage row…}
  event: chunk\ndata: {"content":"Hello"}
  event: chunk\ndata: {"content":" world"}
  event: done\ndata: {…assistantMessage row…}
  ```
- The user message persists FIRST (before the LLM call) so it survives a provider outage — same hygiene as the sync path.
- The assistant message persists AFTER the stream closes, using the accumulated full content. If the persist fails, the stream's `done` event still fires (the user got a useful reply on screen) with `persistFailed: true` so the client can warn — the audit-trail loss is recoverable, the user-facing regression isn't.
- `X-Accel-Buffering: no` header keeps nginx from buffering the stream end-to-end. Harmless when no nginx is in front.
- Mid-flight client disconnect detection: `res.writableEnded` / `res.destroyed` checked between events so the loop exits cleanly when the user navigates away — saves the provider's tokens.

### Changed — web client streams progressively

- New `sendAssistantMessageStream(userId, content, threadId, callbacks)` in `apps/web/public/js/api-client.js`. Uses `fetch` + manual SSE parsing (not `EventSource` — that only supports GET; the assistant endpoint is POST). Callbacks: `onThread`, `onUserMessage`, `onChunk`, `onDone`, `onError`.
- `apps/web/public/js/pages/assistant.js:handleSend` now streams. The user bubble lands optimistically, then thread + user events replace the optimistic IDs, then chunk events update a single bubble's text **in place** (direct DOM update via `data-streaming-id`) without re-painting the page on every token — preserves textarea focus + scroll position during the stream.
- Typing dots now fire only while sending AND before the first chunk lands. Once the streaming bubble appears, it shows the live text — no need for both indicators.
- Mid-stream errors render the partial content in one bubble + an error caveat in another, so the user sees both what landed and what went wrong.

### Tests (24 new)

- `packages/llm-client/src/__tests__/anthropic-sse.test.ts` (7): clean stream, events split across `read()` chunks, benign-event filtering (`message_start` / `ping` / `content_block_start` / `message_stop`), comment-line tolerance, malformed JSON line survival, empty stream, trailing partial-event flush.
- `packages/llm-client/src/__tests__/llm-client.test.ts` (+6): native streaming yields chunks + done, pre-first-chunk failure falls through to next provider, mid-stream failure does NOT fall through (no second-provider call), `AllProvidersFailedError` when no provider yields any chunk, universal fallback path for non-streaming providers, empty-chunk skipping.
- `packages/assistant/src/__tests__/assistant-service.test.ts` (+5): chunk-then-done events, mid-stream error event with partial content, pre-first-chunk failures escape, ContextBuilder prepended to streaming system prompt, no-enrichment skips builder.

### Out of scope for this PR (still deferred)

- Action-intent routing through `@skytwin/decision-engine` (#148).
- Native multi-turn `LlmClient` API (#149).
- Native streaming for OpenAI / Google / Ollama (drop a `streamGenerate` into the provider module + add it to `PROVIDER_STREAM_FNS` — no other changes needed).
- Provider-side cancellation when the user closes the page mid-stream (the route detects disconnect and stops emitting; the underlying provider request is closed by the AbortController on response timeout, but a long-running generation could still continue server-side until that timeout).

## [0.6.1.0] - 2026-05-05

Closes issue #147 — assistant phase 2b. The conversational assistant now reads the user's twin profile (preferences + inferences) and recent episodic memories before composing a reply, so it can answer "what did I tell you about X last month?" and "what's my preference for Y?" — the two killer use cases that distinguish a personal twin from generic ChatGPT.

### Added — `ContextBuilder` in `@skytwin/assistant`

- New `ContextBuilder` composes a compact context block (`## What I know about you` + `## Relevant past episodes`) and prepends it to the system prompt for each request.
- Two ports keep the assistant package free of `@skytwin/db` and `@skytwin/mempalace` deps: `TwinContextProvider.fetch(userId)` for profile data and `MemoryContextProvider.search(userId, query, limit)` for episodic memories. Adapters wire to real backings at composition time in `apps/api/src/routes/assistant.ts`; tests stub them directly.
- **Hard cap at `MAX_CONTEXT_BYTES = 2000`** with UTF-8-clean ellipsis truncation. A noisy profile or long memory hit list cannot dominate the model's token budget.
- **Confidence floor**: only `confirmed`, `high`, and `moderate` preferences/inferences surface. Speculative + low-confidence entries stay in the model but don't broadcast to the LLM (would make the assistant look unsure of itself and frequently wrong).
- **Confidence-ranked truncation**: when a user has more than `MAX_PREFERENCES = 12` qualifying preferences, the highest-confidence ones win the slots. Same for `MAX_INFERENCES = 6` and `MAX_MEMORIES = 5`.
- **Boolean values render as `yes`/`no`** instead of `true`/`false` — more readable for the model and the user reading the rendered prompt in debug logs.
- **Partial-context fallback**: if either provider throws, the other still renders. `console.warn` records which side failed; the request continues with whatever context was retrievable. Better than no context.
- **No-op semantics**: empty result from both providers returns `''`, which AssistantService treats as "use the default system prompt unchanged" — same behavior as phase 1, no surprises.

### Changed — `AssistantService.reply()` now takes optional enrichment

- New optional 2nd parameter `enrichment?: { userId, query }`. When supplied AND a `ContextBuilder` was injected at construction, the rendered context block is prepended to the system prompt for that request.
- Backward-compatible: omitting either the enrichment arg or the ctor builder falls back to the bare default system prompt — phase 1 callers are untouched.
- Service signature change is the 3rd ctor arg; defaults to `null` so existing 2-arg callers compile unchanged.

### Wiring

- `apps/api/src/routes/assistant.ts` constructs a `ContextBuilder` once per process and passes it into the per-request `AssistantService`. `enrichment.query` is the just-sent user message — the assistant is about to answer it, so the most-relevant memories are the ones that match it.
- `TwinContextProvider` adapter pulls `TwinService.getOrCreateProfile` (preferences + inferences) and `userRepository.findById` (trust tier) in parallel.
- `MemoryContextProvider` adapter splits the query into ≥3-char tokens and calls `mempalaceRepository.searchEpisodes` — same backing call that `MemoryStack.search` uses for L3 deep-search. Stop-words and short tokens drop so a query like "the plan for X" doesn't ILIKE-match every episode containing "the".
- Episode `outcome` JSON blobs collapse to a one-line label (`kind` / `status` / `result` field if present, else short stringification) so the rendered context stays compact.

### Tests (15 new)

- `packages/assistant/src/__tests__/context-builder.test.ts` (12): preference rendering with confidence, low-confidence noise floor, confidence-ranked truncation, inference rendering with reasoning, memory rendering with date + outcome, both-empty short-circuit, trust-tier-only suppression, JSON value rendering, byte-cap with UTF-8-clean ellipsis, twin-side throws (memory still renders), memory-side throws (twin still renders), no-memory-provider passthrough.
- `packages/assistant/src/__tests__/assistant-service.test.ts` (+4): context prepended before default system prompt when enrichment supplied, empty context falls back to bare system prompt, no-enrichment skips the builder entirely, no-builder skips even when enrichment is supplied (early-bring-up safety).

### Out of scope for this PR (still deferred)

- SSE streaming (#146).
- Action-intent routing through `@skytwin/decision-engine` (#148).
- Native multi-turn `LlmClient` API (#149).

## [0.6.0.0] - 2026-05-05

Phase 1 of issue #135 — adds a ChatGPT-style conversational assistant at `#/assistant` with the dark glass aesthetic, persisted threads, and four new API endpoints. Out of scope for this phase (deferred to phase 2+): SSE streaming, twin/memory context enrichment, action-intent routing through the decision engine, and tool use.

Minor bump on the major slot: this is the first user-visible new surface since 0.5.x and warrants the bigger jump.

### Added — `@skytwin/assistant` package

- New workspace package with `AssistantService`, `formatHistoryAsPrompt`, `DEFAULT_ASSISTANT_SYSTEM_PROMPT`, and a `MAX_HISTORY_TURNS = 20` cap. Stateless — wraps `@skytwin/llm-client.LlmClient` to turn a `ChatTurn[]` history into the next assistant reply. Persistence and HTTP concerns live elsewhere so the service unit-tests against a stubbed LLM.
- The history cap exists for three reasons: cost, latency, and provider context-window limits. Older turns are persisted (the user sees them) but not fed back to the model — so a year-long thread doesn't quietly start dropping tokens off the front when the prompt overflows.

### Added — DB schema (`assistant_threads`, `assistant_messages`)

- Migration `026-assistant-threads.sql`: parent `assistant_threads (id, user_id, title, created_at, updated_at)` and child `assistant_messages (id, thread_id, role, content, created_at, metadata)`. `ON DELETE CASCADE` so deleting a thread drops its messages atomically.
- Two indexes: `(user_id, updated_at DESC)` for the threads-list hot path and `(thread_id, created_at ASC)` for the message-replay path.
- `metadata JSONB` is reserved for phase 2 — provider/model/latency stamps so the user can see "this reply was generated by claude-opus in 1.2s" without reading the API logs.
- `assistantRepository` in `@skytwin/db` with `createThread`, `listThreads`, `getThread`, `deleteThread`, `appendMessage` (transactional — message insert + parent `updated_at` bump are atomic so a race can't demote a thread that just received a message). Plus a pure `deriveThreadTitle` helper that auto-titles from the first user message (first line, ≤80 chars, ellipsis on overflow, falls back to "New conversation" for empty input).

### Added — API routes (`/api/assistant/*`)

- `POST /api/assistant/messages` — submit a user message, get the assistant reply. Body: `{ userId, content, threadId? }`. If `threadId` is omitted a new thread is created. User message is persisted FIRST so it survives an LLM-provider outage; the reply then appends. Returns `409` when the user has no AI provider configured (dashboard surfaces "set one up in Settings"), `502` when every configured provider fails (`AllProvidersFailedError` from the chain).
- `GET /api/assistant/threads?userId=…` — list up to 50 most-recently-active threads.
- `GET /api/assistant/threads/:threadId?userId=…` — fetch one thread + all its messages chronologically.
- `DELETE /api/assistant/threads/:threadId?userId=…` — cascade-delete the thread.
- All four mounted under `sessionAuth` + `requireOwnership`. Don't-leak-existence semantics on 404: a thread the requesting user doesn't own returns the same response as a thread that doesn't exist.
- Hand-rolled validator `validators/assistant-message.ts` matching the convention in `event-ingest.ts` — UUID checks for `userId` / `threadId`, 16K byte cap on `content` (well under CRDB's row-size limit, generous for conversational input), trim+empty rejection.

### Added — `#/assistant` web route (dark glass)

- New page module `apps/web/public/js/pages/assistant.js` and stylesheet `apps/web/public/css/assistant.css`. Two-column layout: threads rail on the left (with "New" button + per-thread delete), message log + composer on the right.
- Uses the existing CSS variable theme system in `themes.css` (`--bg-card`, `--accent`, `--glass-blur`, etc.) so the chat surface tracks whichever variant + mode the user has selected. Issue spec'd `#0b0d10` background; the existing `warm-glass` dark variant ships with `#0c0a14` which is functionally identical and reuses infrastructure rather than forking a parallel theme.
- Composer: textarea + send button. Enter submits, Shift+Enter inserts a newline. Optimistic user bubble renders immediately; assistant typing dots animate during the round-trip; both replaced with persisted server messages on response.
- Singleton click + submit + keydown delegators wired once to `document`, gated by `window.location.hash` per the CLAUDE.md "Frontend Event Handling" rules. Re-renders during the page lifetime (after every send, after delete) do not stack new listeners.
- All Gmail-controlled / user-controlled strings flow through `escapeHtml` before landing in `innerHTML`. No inline `onclick` attributes.
- Respects `prefers-reduced-motion` — bubble entrance animation and typing-dot bounce both no-op when set.

### Tests (24 new)

- `packages/assistant/src/__tests__/assistant-service.test.ts` (8): happy path, custom system prompt, history cap dropping oldest turns, provider failure propagation, prompt formatting (user/assistant labels, system pass-through, empty history).
- `packages/db/src/__tests__/assistant-thread-title.test.ts` (7): short, long-truncate, multi-line, CRLF, whitespace, empty fallback, exact-boundary preservation.
- `apps/api/src/__tests__/assistant-message-validator.test.ts` (10): minimal payload, threadId continuation, content trim, non-object body rejection, UUID enforcement on both ids, empty/whitespace content, oversized content, non-string content, empty-string threadId rejection (don't silently start a new thread on a malformed continuation), null/undefined threadId acceptance.

### Out of scope for this PR (phase 2+)

- SSE streaming on `POST /messages` — the route is structured to layer this on without redesign.
- Twin profile + Memory Palace context enrichment in the system prompt.
- Action-intent routing through `@skytwin/decision-engine` — the assistant cannot send mail / modify calendar / spend money in phase 1. The default system prompt tells the user to use the rest of the dashboard for that.
- Multi-turn LLM API (today the prompt format flattens history with `User:` / `Assistant:` labels — tracked as a `LlmClient` refactor for phase 2).
- Feedback (thumbs up/down on a reply) — wired to twin model in phase 2 per Safety Invariant #6.
- Mobile chat UI tracked separately under `apps/mobile`.

## [0.5.6.0] - 2026-05-05

Two follow-ups from the v0.5.5.0 (#136) /review that were intentionally deferred to keep the original PR focused on closing #122. Both shrink production risk for the Gmail-label model.

### Changed — single source of truth for sender normalization

- **`normalizeSenderAddress` moved to `@skytwin/core`** (`packages/core/src/email-normalize.ts`). Previously implemented twice: once in `packages/connectors/src/gmail-connector.ts` (write side, used by `recordObservations`) and once in `packages/decision-engine/src/decision-maker.ts` as a private `normalizeSender` (read side, used by `topLabelsForSender` lookup). A comment said "they MUST stay in sync" — they now do by construction. The connector re-exports the symbol for back-compat with downstream imports of `@skytwin/connectors`.
- 8 unit tests in `packages/core/src/__tests__/email-normalize.test.ts` covering display-name stripping, lowercasing, `@`-poisoning guard, malformed angle brackets, non-string inputs, and idempotency.

### Added — bounded growth for `email_label_signals`

- **`emailLabelRepository.pruneStaleSignals(userId, options?)`** drops rows past a TTL (default: 180 days, count<3) then enforces a per-user hard row cap (default: 5000). Returns `{ deletedStale, deletedOverCap }` so the caller can log how aggressively each gate fires. Idempotent — second call drops ~0 rows.
- **Worker integration** (`apps/worker/src/label-signal-pruner.ts` + `apps/worker/src/index.ts`) — new `createPruneThrottle` helper gates the prune at "once per 24h per user," called opportunistically from the existing `pollUser` loop. No separate scheduler. Stamps the throttle timestamp synchronously before awaiting so concurrent polls cannot double-fire. Errors swallowed via the throttle's `onError` hook — staying tidy is best-effort, not load-bearing on signal ingestion.
- 7 unit tests in `apps/worker/src/__tests__/label-signal-pruner.test.ts`: first-call runs, throttled within interval, runs again after interval, per-user isolation, error swallowing, sync timestamp stamping (concurrency guard), 24h default.

### Why these are real risks, not over-engineering

The cardinality cap is the load-bearing one. Without it, an attacker who can email the user (or any newsletter service that rotates per-message `From:` addresses) writes one row per unique sender forever. The table grows without bound, every email decision pays the cost in `topLabelsForSender` lookups, and the lookup itself starts returning weaker results because the `LIMIT 5` fills with one-off noise rows. The 5000-row cap with the lowest-count + oldest eviction order is what the read path's `ORDER BY count DESC, last_seen_at DESC` already prefers — we just enforce the same preference at write throttle time. Drift between the read and write models was the original concern that motivated the normalize-sender extraction; same theme.

## [0.5.5.0] - 2026-05-05

Closes issue #122 — the Twin no longer suggests labels via a hardcoded subject-keyword classifier. It now learns from each user's actual Gmail history.

### Added — per-user Gmail label model

- **`email_label_signals` table** (`packages/db/src/migrations/025-email-label-signals.sql`) accumulates `(user_id, sender, label)` rows with a `count` and `last_seen_at`. Compound primary key on the tuple gives idempotent UPSERT; the `(user_id, list_id)` partial index supports the secondary List-Id lookup for mailing-list traffic where per-message `From` varies.
- **`emailLabelRepository`** (`packages/db/src/repositories/email-label-repository.ts`) — `recordObservations(userId, [{sender, label, listId}])` for the connector's write path; `topLabelsForSender(userId, sender)` and `topLabelsForListId(userId, listId)` for the decision-engine's read path.
- **`LabelObserver` port on the Gmail connector** — every fetched message now contributes one observation per labelId. Sender is normalized to the bare lowercase address before write so the decision-side lookup matches. The `recordLabelObservations` call is best-effort: a label-store outage logs a warning but does not stop signal ingestion.
- **`List-Id` header is now extracted** from each message and plumbed through to `RawSignal.data.listId`. Used as a secondary signal in `inferLabels` when the per-sender lookup is empty (mailing lists like `<rangers.lists.example.org>` whose `From` rotates per send).

### Changed — `inferLabels` consults the per-user model first

- **`packages/decision-engine/src/decision-maker.ts:inferLabels`** now takes a `senderLabelHints` array. When the sender has ≥2 prior observations of a non-system, non-`CATEGORY_` label, the decision engine suggests that label (top-2). With ≥5 observations the candidate's confidence rises to HIGH; with ≥2 it's MODERATE; pure keyword fallback drops to LOW so policy gates ask for approval. Gmail system labels (INBOX, IMPORTANT, SENT, …) and `CATEGORY_*` are recorded but filtered from suggestions — the user can't meaningfully reuse them as a categorization.
- **New `LabelInferencePort`** on `DecisionMaker` (optional ctor arg). `evaluate()` pre-fetches sender / List-Id hints before candidate generation. Falls back to keywords transparently when the port is missing, the decision isn't from email, or the lookup throws.
- **Sender normalization** lives on both sides (`gmail-connector.ts:normalizeSenderAddress` and `decision-maker.ts:normalizeSender`) and applies the exact same transformation. They MUST stay in sync — both strip `Display Name <addr@host>` to lowercase `addr@host` before the lookup.

### Wiring

- `apps/api/src/routes/events.ts` — both DecisionMaker instantiations (rule-based fallback + LLM-strategy variant) now receive a `LabelInferencePort` adapter wrapping `emailLabelRepository`.
- `apps/worker/src/index.ts` — every `GmailConnector` is constructed with a `LabelObserver` adapter wrapping `emailLabelRepository.recordObservations`.

### Tests

- `packages/decision-engine/src/__tests__/label-inference.test.ts` (10): learned-label happy path, keyword fallback when sender is unknown, system-label filtering, sub-threshold evidence is ignored, List-Id secondary signal, sender-name normalization round-trip, port-throw degrades to keywords, no-port path still works, plus 2 post-/review tests for the sub-threshold-suppresses-listId fix.
- `packages/connectors/src/__tests__/gmail-label-observer.test.ts` (15): `normalizeSenderAddress` and `parseListId` pure-function contracts, observer invocation with normalized sender + listId, skips on unparseable sender, skips on no-labels message, observer errors do not stop signal emission, listId plumbed onto signal.
- `packages/db/src/__tests__/email-label-validation.test.ts` (5): `isAcceptableLabel` accepts ordinary user labels and Gmail system labels, rejects HTML/JS injection, oversized inputs, and characters off the whitelist (semicolon, backtick, dollar, brace, bracket).

### Fixed (post-/review)

- **Sub-threshold sender hints suppressed the List-Id fallback.** Pre-fix: a single count=1 sender row would short-circuit the List-Id lookup, so for mailing-list traffic where per-message `From:` rotates, a one-off forward could mask the much richer per-list model. Now we only short-circuit when at least one sender hint clears `LABEL_HINT_MIN_COUNT`.
- **System labels filtered client-side after `LIMIT N`.** Pre-fix: a sender with 5+ `CATEGORY_*` observations crowded the user's actual labels out of the `topLabelsForSender` result entirely, so the lookup silently returned 0 usable hints despite ample evidence. Filter is now in the SQL `WHERE` clause for both `topLabelsForSender` and `topLabelsForListId`.
- **N independent `INSERT … ON CONFLICT` queries per message.** Pre-fix: 10 messages × ~5 labels per Gmail poll = 50 sequential round-trips per cycle; mid-loop failure left a partial label set written. Replaced with a single multi-row INSERT — one statement, one transaction, atomic per message.
- **Label strings written without validation.** Pre-fix: Gmail-controlled label strings flowed verbatim into approval-card text and into `parameters.labels` JSON of execution plans; only render-layer `escapeHtml` stood between hostile content and downstream sinks. Added `isAcceptableLabel` whitelist (alphanumeric + safe punctuation, length ≤100, rejects control chars + angle brackets) at the write boundary in `recordObservations`.

## [0.5.4.0] - 2026-04-29

Last of the post-/review follow-ups from PR #126. Closes the P2 item that's been bothering me since the merge: every inline `onclick=` in the dashboard / approvals / decisions / settings / setup pages.

### Changed — XSS hardening

- **40 inline `onclick="…handleX('${escapeHtml(value)}')"` sites migrated** to `data-action="…"` + delegated `addEventListener` bindings across `apps/web/public/js/pages/{approvals,settings,decisions,setup,dashboard,dashboard-view}.js`. `escapeHtml` is HTML-context safe but values land in JS-string-literal context; UUIDs / enums / constants are safe today, the pattern wasn't. Each page now installs one click delegator that reads DOM attributes — no more concatenating user-controlled strings into executable HTML.
- **`dashboard-view.js` Ask-Your-Twin** now uses a delegated `keydown` listener for Enter-to-submit instead of an inline `onkeydown` interpolating `userId` into a JS string.
- **`approvals.js`** dropped its single-purpose `escapeAttr` helper (only used for the migrated escalation suggestion `label`); no equivalent JS-string escape is needed once values flow through `data-*` attributes.

### Fixed — listener leak in the singleton delegators

- **Listener leak in approvals / decisions / settings.** The first cut wired the click delegator inside `renderX(container, ...)` via `container.addEventListener`. Settings re-renders after every save/delete, decisions re-renders on every SSE `decision:executed`, approvals re-renders on cross-page navigation — so listeners stacked, and by the third trip a single click fired duplicate POSTs (and toasts and OAuth redirects). Fix: hoist each delegator to a module-level `_pageListenerWired` guard, attach once on `document`, and gate by `window.location.hash` since the SPA reuses one `#page-content` container across routes (DOM containment can't scope it). Settings handler also reads `getCurrentUserId()` inline instead of closing over the render argument so the dev "Switch user" button can't leave a stale-userId listener firing under the next user.
- **dashboard `data-action="connect-google"` namespace collision.** Same hash-route gate added to the dashboard's document-level click + keydown delegators in `dashboard-view.js` so they don't fire on settings.js's own `connect-google` button (and vice versa).

## [0.5.3.0] - 2026-04-29

### Changed

- **Dashboard split into entry point + view layer.** `apps/web/public/js/pages/dashboard.js` was 1023 lines mixing data fetching, model derivation, HTML composition, and post-render side effects. Split presentation into `dashboard-view.js` (583 lines: pure render helpers, label maps, the global handlers their inline `onclick` attributes reference, and `initDashboardGlobals`). Entry point shrinks to 483 lines focused on lifecycle. Zero runtime behavior change. `initDashboardGlobals` is re-exported from `dashboard.js` so `app.js`'s existing import keeps working.

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
