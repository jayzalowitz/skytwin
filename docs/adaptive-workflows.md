# Versioned adaptive workflows

SkyTwin's first adaptive workflow is `signal_digest.v1`: a read-only Watch that
matches owner-scoped signals on a schedule and presents cited results. The user
teaches it in plain language, reviews a replay against real data, and explicitly
activates an immutable version. AI can translate or summarize; it cannot grant
authority, activate a version, select credentials, or execute tools.

Source of truth:

- shared envelope and immutable metadata: [`packages/shared-types/src/adaptive-workflow.ts`](../packages/shared-types/src/adaptive-workflow.ts)
- provider schema/compiler/replay/diff: [`packages/routines/src/adaptive-signal-digest.ts`](../packages/routines/src/adaptive-signal-digest.ts)
- API composition: [`apps/api/src/lib/adaptive-workflow-service.ts`](../apps/api/src/lib/adaptive-workflow-service.ts)
- CockroachDB transactions: [`packages/db/src/repositories/workflow-repository.ts`](../packages/db/src/repositories/workflow-repository.ts)
- Watch execution: [`apps/worker/src/jobs/watch-scheduler.ts`](../apps/worker/src/jobs/watch-scheduler.ts)

## Teach and activate a signal digest

1. Open **Watches** and describe one recurring digest, including its source or
   filter, cadence, time when required, and desired summary.
2. If one essential detail is missing, answer the single clarification. SkyTwin
   preserves the draft locally so setup, policy, runtime, or temporary provider
   failures can be resumed.
3. Review the candidate. Replay reads recent real signals for that owner and
   shows caught/ignored counts, up to three cited examples, data scope,
   schedule/timezone, and AI synthesis. The UI labels this replay **Real, not
   synthetic**; pasted-example replay is not supported in this slice.
4. Select **Activate**. Activation is explicit; creating or editing a proposal
   never moves the active pointer.
5. To correct it, submit feedback or a structured edit. SkyTwin creates a new
   immutable version, computes the semantic diff on the server, and compares
   its replay with the active version. Activate it separately.
6. To return to an older definition, choose that previously active version and
   roll back. Rollback appends an activation event; it does not rewrite history.

## Runtime behavior

Each claimed adaptive Watch slot retains the exact workflow and version IDs,
provider and schema versions, canonical content hash, projection/compiler
version, canonical payload snapshot, the version's sanitized inference identity
when model-assisted (or an explicit no-inference state for a user-authored
revision), and the exact time window. A retry therefore keeps the originally
claimed version, semantics, and window even if another version becomes active.
Completion commits the evidence actually evaluated: a bounded display snapshot
plus a commitment over the complete matched set.

Matching is deterministic. If summary inference is unavailable, the run still
records and presents the cited matches with `AI summary unavailable`; there is
no silent local-to-cloud fallback. Legacy Watches and historical runs remain
unattributed unless an exact version can be proven. For this read-only Watch,
the result summary, pinned filter/spec, synthesis identity, and cited evidence
form the explanation equivalent; the run does not create an
`ExplanationRecord` for an effect-bearing action.

## Authoring readiness and model boundary

Model recommendation, artifact download, runtime availability, and structured
workflow-authoring readiness are distinct states. A managed embedded model may
author a workflow only when the exact registry artifact and exact evaluated
`llama.cpp` build pass the checked-in v1 gate: 100% safety, at least 95%
semantic intent accuracy, at least 95% exact revision preservation, and every
call under three minutes. Unqualified managed models remain available for
ordinary local inference but fail closed for workflow authoring; the maintained
managed catalog currently has no qualified workflow-authoring artifact.

Adaptive Ollama calls require the response itself to attest the exact served
model-manifest SHA-256 and server version, in addition to pre-inference,
resident-model, and post-inference probes. Released stock Ollama builds do not
currently expose that response-bound identity (tracked upstream in
[ollama/ollama#18394](https://github.com/ollama/ollama/issues/18394)), so
adaptive authoring and summaries fail closed before persistence. Ordinary
non-exact Ollama chat remains supported. Scheduled embedded summaries recheck
the pinned artifact and runtime build after generation. Missing, ambiguous, or
changing identity fails closed, and provider fallback remains inside the
selected reasoning-mode boundary.

The authoring prompt accepts only the closed intent/clarification schema and one
bounded repair attempt. The model cannot represent provenance, permissions,
risk, reversibility, credentials, activation state, or execution authority.
The server canonicalizes, validates, compiles, hashes, replays, and persists the
result. Invalid output creates no workflow version.

## Concurrency and retries

Initial drafts and revisions require a UUID `Idempotency-Key`. The server looks
up the key and canonical request hash before expensive authoring, then stores
them atomically with the resulting proposal. A retry after commit reuses the
durable mutation without repeating authoring/revision inference or creating
another version; current replay evidence and optional replay synthesis are
refreshed. Two simultaneous first attempts may both reach inference, but the unique database
boundary reconciles them to one durable version/proposal. Reusing the key with
a different request returns `409`.

Activation and rollback use CockroachDB serializable transactions and compare
the caller's `expectedActiveVersionId` with the locked current pointer. A stale
client receives `active_version_conflict`; SQLSTATE `40001` is retried by the
database transaction boundary. Activation also atomically replaces the Watch
projection, so runtime and version state cannot diverge.

## API reference

All routes require the normal authenticated session and owner match. IDs and
`Idempotency-Key` values are UUIDs.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/adaptive-workflows/:userId/readiness` | Explain exact authoring readiness or failure state. |
| `POST` | `/api/adaptive-workflows/:userId/signal-digest-drafts` | Author, compile, replay, and persist an initial proposal. Requires `Idempotency-Key`. |
| `GET` | `/api/adaptive-workflows/:userId` | List owner-scoped workflows. |
| `GET` | `/api/adaptive-workflows/:userId/resumable-draft` | Return the newest inactive proposal for resume. |
| `GET` | `/api/adaptive-workflows/:userId/:workflowId` | Return workflow, active version, proposals, and activation history. |
| `GET` | `/api/adaptive-workflows/:userId/:workflowId/versions` | List immutable versions. |
| `POST` | `/api/adaptive-workflows/:userId/:workflowId/revisions` | Propose a validated structured payload revision. Requires `Idempotency-Key`. |
| `POST` | `/api/adaptive-workflows/:userId/:workflowId/feedback-revisions` | Ask the admitted model for a minimal correction. Requires `Idempotency-Key`. |
| `POST` | `/api/adaptive-workflows/:userId/:workflowId/activate` | Compare-and-swap the active pointer and Watch projection. |
| `POST` | `/api/adaptive-workflows/:userId/:workflowId/rollback` | Select a previously active version and append rollback history. |

Authoring failures distinguish setup, explicit confirmation, artifact, runtime,
policy, unsupported-model/conformance, temporary-health, and clarification
states. The UI should preserve the user's description for every recoverable
state rather than turning setup friction into data loss. When no model is
configured (`setup_required`), the UI offers a clearly labeled deterministic,
non-versioned Watch fallback. Every other readiness failure blocks AI
authoring while preserving the draft; it does not silently downgrade the
proposal or cross a model-location boundary.

Both readiness and resumable-draft GETs are inference-free. Readiness inspects
configuration and local artifact/runtime capabilities; schema conformance is
validated only after an explicit authoring POST. Resuming recomputes the
deterministic real-data replay but returns `AI summary unavailable` rather than
sending signal citations to a model on page load.

| State | User-visible meaning and remediation | Retryable |
|---|---|---|
| `ready` | Structural prerequisites are present; submit explicitly to validate the model output. | No retry needed |
| `setup_required` | No provider is configured; configure one or choose the labeled deterministic legacy Watch fallback. | No |
| `confirmation_required` | Confirm the reasoning-location mode in Settings. | No |
| `policy_blocked` | The configured provider violates the selected location policy; change the mode or provider. | No |
| `artifact_unavailable` | Install or replace the exact managed artifact. | No |
| `runtime_unavailable` | Install, start, or repair the compatible local runtime. | Yes |
| `temporarily_unavailable` | The provider timed out or is unhealthy; try again later. | Yes |
| `unsupported_model` | The model/runtime cannot satisfy the quality, schema, or identity contract; choose a supported provider. | No |
| `clarification_required` | Answer the one bounded clarification before resubmitting. | No |
| `loading` (UI only) | The readiness request is in flight. | No |
| `load_error` (UI only) | The readiness request failed before a server state was returned. | Yes |

Replay readiness is separate: `sourceReady: false` means no recent signal from
the requested source exists in the bounded real-data window. The preview shows
that it is waiting for recent evidence; it does not invent synthetic examples.

## Backup, restore, export, and deletion

Backup schema v6 carries workflows, immutable versions, sanitized inference
metadata, proposals and their idempotency bindings, activation history, and the
current Watch projection. Runtime `watch_runs` remain operational history and
are not exported by this user backup format. Restore validates hashes, lineage,
ownership, active pointers, proposal transitions, and projection pins before
its single transaction writes anything. User purge relies on owner-scoped
foreign keys plus repository cleanup and removes this state with the user.

See [`backup-restore.md`](./backup-restore.md) and
[`cockroach-architecture.md`](./cockroach-architecture.md).

## Current boundary

`signal_digest.v1` is deliberately vertical, not a universal workflow DAG. It
does not send, delete, modify, spend, install, execute code, silently discover
workflows, or silently expand authority. Later providers can reuse the stable
envelope while owning their own typed payload and compiler. Action-bearing and
multi-step workflows remain separate reviewed milestones in
[epic #744](https://github.com/jayzalowitz/skytwin/issues/744).
