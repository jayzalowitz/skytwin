# Inference receipts

SkyTwin's version-1 inference receipt is a signed, metadata-only record linked
to one decision and its `ExplanationRecord`. It identifies the reasoning path,
provider, model, endpoint, hashes of the exact request and response bytes,
cost basis, and verification or fallback outcome. It does not store prompts,
responses, credentials, chain-of-thought, or complete attestation documents.

This first slice provides the contract, trusted-recorder persistence boundary,
owner-scoped read/delete repository and API paths, backup/restore support, and
an independent command-line verifier. Automatic receipt creation in every
decision workflow and the receipt detail UI remain gated on the strict
confidential-provider integration; until those land, absence of a receipt must
be displayed as unavailable and must never be inferred as a privacy outcome.

## Independent verification

An export bundle contains the canonical signed receipt plus the exact request,
response, and (for confidential verification) minimum evidence bytes. Verify it
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
verification freshness; reasoning-mode/status consistency; and a recorder seal
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

Receipt rows contain identifiers and inference metadata. They are not yet
application-level encrypted; operators should use full-disk encryption, as
documented in the privacy policy. They cascade-delete with their decision or
user and can be explicitly deleted atomically through the authenticated decision receipt
route. User backups include the canonical receipt metadata; restore verifies its
self-contained metadata seal and exact linkage before writing it. Because an
embedded key is not an identity trust root, restored rows are explicitly marked
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
