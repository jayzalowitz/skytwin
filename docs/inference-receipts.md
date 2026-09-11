# Inference receipts

SkyTwin's version-1 inference receipt is a signed, metadata-only record linked
to one decision and its `ExplanationRecord`. It identifies the reasoning path,
provider, model, endpoint, and hashes of SkyTwin's versioned canonical logical
input and output bytes,
cost basis, and verification or fallback outcome. It does not store prompts,
responses, credentials, chain-of-thought, or complete attestation documents.

The decision-event ingest path calls `resolveUserLlmClient` once to read the
persisted reasoning mode and enabled provider chain in one database snapshot,
install the receipt trace sink, and construct the mode-scoped `LlmClient`.
Legacy or unconfirmed modes, incompatible providers, and empty chains produce
no client and therefore make zero provider calls. It captures every completed
call made through that resolved instance and persists the resulting batch after the real `ExplanationRecord`
exists but before approval creation or action execution. A decision may have
multiple receipts because interpretation, candidate generation, and drafting
can be separate calls. The metadata API currently returns the latest receipt;
the repository and backup format retain the complete set. The receipt detail UI
remains future work; absence of a receipt must be displayed as unavailable and
must never be inferred as a privacy outcome.

The receipt stores the requested `ReasoningMode` separately from its observed
execution class. Location, network scope, confidentiality, verification state,
and sanitized fallback attempts come from typed `ProviderExecutionMetadata`
created at the provider boundary; provider names, endpoint strings, and caller
labels are not receipt evidence. A loopback Ollama endpoint is on-device, while
a remote Ollama endpoint is conventional external execution. No provider chain
may cross the selected mode boundary. The default Ollama endpoint uses the same
canonical loopback identity and DNS-pinned, redirect-disabled transport as an
explicit endpoint. Trailing-dot localhost forms normalize to local; a DNS alias
that resolves to loopback is rejected before its prompt is sent. Hosted costs remain `unknown` until provider usage/billing identifiers are
available; local runtime cost is exactly zero. Conventional and local records
cannot carry attestation fields. The decision-event integration does not yet
configure a confidential verifier, so `verified_private_cloud` is fail-closed
and cannot emit or display a `verified_confidential` execution class. The lower-level contract requires an independently
configured verifier and pinned provider trust roots; neither may be derived
from keys or evidence returned by the verifier. Failed, unavailable, or stale
verification has distinct receipt statuses in the versioned contract; no
confidential execution adapter is enabled in the current decision path. Other application LLM clients (including
assistant, Lifebooks, and adaptive setup flows) are not covered by this slice
and must not be presented as receipt-backed.

Signal idempotency is checked before the receipt-aware client is constructed,
so an already-complete duplicate makes no new provider call. The database
uniqueness constraint remains the concurrent-ingest backstop; if two first
ingestions race and the losing request has already produced an interpretation
trace, that trace is finalized against the winner's durable explanation before
the recovered response returns.

For a stable recorder identity, configure `SKYTWIN_RECEIPT_KEY_ID`,
`SKYTWIN_RECEIPT_PRIVATE_KEY_BASE64`, and
`SKYTWIN_RECEIPT_PUBLIC_KEY_BASE64` together. With none configured, the API
creates a process-local Ed25519 identity. Those receipts are still
integrity-checkable using their embedded key, but the recorder identity is not
stable across restarts and must not be presented as a release-pinned identity.

## Independent verification

An export bundle contains the canonical signed receipt plus SkyTwin's canonical
logical input/output and (for confidential verification) minimum evidence
bytes. These are provider-neutral application-boundary values, not exact HTTP
payloads, headers, raw response bodies, or transport transcripts. Verify it
without running the API or web UI:

```bash
skytwin-verify-receipt ./receipt-export.json --integrity-only
# For a non-confidential receipt, require a pinned recorder identity:
skytwin-verify-receipt ./receipt-export.json \
  --recorder-key-id recorder-2026-01 \
  --recorder-public-key ./trusted-recorder.pem
```

The command emits one JSON result. `--integrity-only` verifies hashes, the
recorder seal, and any embedded provider response signature, but deliberately
does not trust the embedded identities or accept attestation evidence; it can
only report cryptographic integrity (`INTEGRITY_ONLY`). Without that explicit
flag, missing trust roots fail closed. The command exits
non-zero unless the recorder is trusted or the caller explicitly selects
`--integrity-only`, so automation cannot silently confuse the two. It checks the
request, response, and evidence hashes; the provider response signature;
verification freshness; requested-mode, execution-class, and status consistency;
the typed execution path (including failed and circuit-open attempts); and a recorder seal
covering every receipt field. Changing model, endpoint, user/decision linkage,
fallback, cost, timestamp, hashes, or signature invalidates the result.

The public key embedded in an export makes internally consistent tampering
detectable, but an attacker can replace both data and embedded keys. Identity
trust still requires comparing its key ID and public key with a trusted release
or provider key published out of band. Server persistence performs that check
against configured trusted recorder keys; it never accepts the bundle's key as
its own authority. A `verified` confidential receipt additionally requires a
caller-configured provider key and a provider-specific attestation-policy
verifier. Hashing opaque evidence is not attestation verification, so this
generic CLI deliberately cannot return `PASS` for a verified-confidential
receipt. An integrating application can wire that provider-specific verifier
through the library API.

## Privacy, retention, and deletion

Receipt rows contain identifiers and inference metadata. Canonical logical
input/output and verification-evidence bytes exist only while the route validates
and inserts the metadata receipt; they are not written to the receipt table.
Receipt rows are not yet
application-level encrypted; operators should use full-disk encryption, as
documented in the privacy policy. They cascade-delete with their decision or
user and can be explicitly deleted atomically through the authenticated decision receipt
route. User backups include the canonical receipt metadata and restores keep it
linked to the restored explanation, but restored rows are explicitly marked
`imported_unverified` until a trust-aware verification process promotes them.
Standalone verification exports are more
sensitive because they contain the exact supplied request and response bytes;
users should protect or delete those files according to their own retention
needs.

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
