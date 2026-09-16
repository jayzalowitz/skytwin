# Inference receipts

SkyTwin's version-1 inference receipt is a signed, structured record linked to
one decision and its `ExplanationRecord`. It identifies the reasoning path,
provider, model, endpoint, and hashes. Local and conventional receipts hash a
canonical logical request plus provider-neutral response bytes; verified
confidential receipts hash the exact provider HTTP request and response bodies,
cost basis, and verification or fallback outcome. It has no dedicated fields
for prompts, responses, credentials, chain-of-thought, or complete attestation
documents. Several identifier and reason fields are free-form strings, however,
so integrators must not place source content or secrets in them. The contract
cannot determine whether an arbitrary string contains sensitive content.

Within one successfully finalized decision-event attempt, the ingest path
captures each completed call made through its receipt-aware `LlmClient` and
persists the resulting batch after the real `ExplanationRecord` exists but
before approval creation or action execution. A decision may have multiple
receipts because interpretation, candidate generation, and drafting can be
separate calls. The metadata API returns the latest receipt; the repository and
backup format retain the complete set. If an attempt stops after the decision
row is durable but before receipt finalization, re-ingestion fails closed with a
recovery-required response before constructing a client, running inference, or
starting side effects. It does not synthesize a complete batch from a later
attempt's partial causative history. Availability-preserving recovery requires a
future durable provisional trace journal or an atomic-restart design.
Other application LLM clients, the receipt detail UI, and a product export route
remain future work. Absence of a receipt must be displayed as unavailable and
must never be inferred as a privacy outcome.

On-device and conventional calls are classified from their configured runtime
mode. Hosted costs remain `unknown` until provider usage or billing identifiers
are available; local runtime cost is exactly zero. A user-configured
TrustedRouter call can produce `verified_confidential` only after the pinned
adapter verifies its same-session gateway attestation and exact-byte receipt.
NEAR AI cannot produce that status in this build: its base-CVM evidence does
not pin the dynamically selected model/proxy workload, so provider admission
fails closed. Because TrustedRouter's dynamic route pricing is not yet
persisted with freshness metadata, the hard-spend gate excludes it from
unattended calls.

For a stable recorder identity, configure `SKYTWIN_RECEIPT_KEY_ID`,
`SKYTWIN_RECEIPT_PRIVATE_KEY_BASE64`, and
`SKYTWIN_RECEIPT_PUBLIC_KEY_BASE64` together. With none configured, the API
creates a process-local Ed25519 identity. Its receipts remain
integrity-checkable using the embedded key, but the recorder identity is not
stable across restarts and must not be presented as release-pinned.

## Independent verification

An export bundle contains the canonical signed receipt plus its captured
request, response, and (for confidential verification) minimum evidence bytes.
Verified-confidential bundles contain exact HTTP body bytes; other modes contain
provider-neutral application-boundary values. Headers and full transport
transcripts are not included. When the provider signs a JWS rather than the raw
response body, the receipt records the verified JWS signing input; the generic
verifier parses its signed claims and requires them to bind the exported
request hash, response hash, and selected model before evaluating
caller-supplied provider and attestation trust roots. For the staged NEAR AI
format, the receipt records the verified
`model:request_sha256:response_sha256` payload and the generic verifier checks
that tuple against the exported bytes before evaluating trust roots. The product
does not export this bundle in this slice: the receipt GET route cannot be used
as verifier input. Integrators and developers can construct a bundle against
the versioned library contract and run the verifier from a built source checkout
without starting the API or web UI:

```bash
pnpm --filter @skytwin/db... build
node packages/db/dist/bin/verify-inference-receipt.js \
  ./receipt-export.json --integrity-only
# For a non-confidential receipt, require a pinned recorder identity:
node packages/db/dist/bin/verify-inference-receipt.js \
  ./receipt-export.json \
  --recorder-key-id recorder-2026-01 \
  --recorder-public-key ./trusted-recorder.pem
```

`skytwin-verify-receipt` is also declared as the `@skytwin/db` package bin for
consumers that deliberately install or link that private workspace package. A
normal SkyTwin checkout or desktop installation does not put that bare command
on the user's `PATH`, which is why the source-checkout command above names the
built entry point directly.

The command emits one JSON result. `--integrity-only` verifies hashes, the
recorder seal, and any embedded provider response signature, but deliberately
does not trust the embedded identities or accept attestation evidence; it can
only report cryptographic integrity (`INTEGRITY_ONLY`). Without that explicit
flag, missing trust roots fail closed. The command exits
non-zero unless the recorder is trusted or the caller explicitly selects
`--integrity-only`, so automation cannot silently confuse the two. It checks the
request, response, and evidence hashes; the provider response signature;
verification freshness; reasoning-mode/status consistency; and a recorder seal
covering every receipt field. Changing model, endpoint, user/decision linkage,
fallback, cost, timestamp, hashes, or signature invalidates the result.
For an on-device, conventional, failed, unavailable, stale, or fallback receipt,
`PASS` means only that the configured recorder identity signed that outcome. It
is never, by itself, a confidential-computing result.

The public key embedded in an export makes internally consistent tampering
detectable, but an attacker can replace both data and embedded keys. Identity
trust still requires comparing its key ID and public key with a trusted release
or provider key published out of band. The repository create boundary requires
its caller to supply trusted recorder keys; it never accepts the bundle's key
as its own authority. Decision-event ingestion is the production caller and
uses either the three-part recorder-key configuration described above or a
process-local ephemeral key. A `verified` confidential receipt additionally
requires a caller-configured provider key and a provider-specific
attestation-policy verifier. Hashing opaque evidence is not attestation
verification, so this generic CLI deliberately cannot return `PASS` for a
verified-confidential receipt. An integrating application can wire that
provider-specific verifier through the library API.

## Privacy, retention, and deletion

Receipt rows contain identifiers and inference metadata, including provider,
model, endpoint identity, hashes, cost and optional billing identity,
verification metadata, and public signatures. Free-form receipt strings must
not contain source content or secrets, but this requirement is not mechanically
enforceable for arbitrary strings. The receipt JSON is therefore conservatively
treated as potentially source-bearing and is not application-level encrypted;
operators should use full-disk encryption, as documented in the privacy policy.
Rows cascade-delete with their decision or user and can be
explicitly deleted atomically through the authenticated
`DELETE /api/decisions/:decisionId/receipt` route. User backups include the
canonical receipt metadata; restore verifies its self-contained metadata seal
and exact linkage before writing it. Durable capture-completion order is
persisted as a zero-based ordinal, so multiple calls with one transaction
timestamp still have a deterministic latest row. Older schema-v3 archives without the
ordinal remain accepted and derive it from array order; duplicate receipt IDs
are rejected before database writes. Because an embedded key is not an identity
trust root, restored rows are marked `imported_unverified`. This slice has no
trust-aware promotion workflow, so they remain untrusted after restore.
Canonical logical input/output bytes for local and conventional calls, exact
provider HTTP body bytes plus verification evidence for verified-confidential
calls, live in transient request memory while an uninterrupted route validates
and inserts receipt metadata, and may remain until JavaScript references are
released and garbage collection runs. They are never written to the receipt or ingest-guard
tables, which is why an interrupted pre-finalization attempt cannot be safely
completed by retry today.
Standalone verification bundles are more sensitive because they contain the
supplied request and response bytes. The product does not export those bundles
yet; integrators who create them should protect or delete the files according
to their own retention needs.

Receipt completion and continuation authority are finalized in one transaction.
The continuation guard binds the owner-scoped persisted outcome flags, selected
action, risk and policy snapshot, and exact explanation. Re-ingestion consumes
that single snapshot; it never joins guard authority to later-mutated outcome or
explanation rows. An execution stream exception remains `running`/ambiguous for
reconciliation and is never recorded as a terminal failure merely because the
response stream broke. The ready-to-running
claim creates and binds its execution plan in the same transaction; terminal
state is accepted only when that exact plan has a matching persisted plan status
and execution result.

## Security boundary

Only a configured provider-specific attestation verifier can establish that supplied evidence matched a supported policy
and that a response was bound to a key. It does not prove model correctness,
absence of vulnerabilities, local operating-system integrity, connector
confidentiality, or action safety. Receipt verification never authorizes an
action. Policy evaluation, provenance/injection checks, trust tiers, spend
limits, reversibility classification, and explanations remain authoritative.

`on_device` means no hosted model was used for that inference. It does not mean
the entire application, connectors, model downloads, or updates were offline.
`conventional` never means confidential or attested. Failed, unavailable,
stale, and explicit local-fallback statuses remain distinct signed outcomes.
