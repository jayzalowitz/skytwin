# Inference receipts

SkyTwin's version-1 inference receipt is a signed, structured record linked to
one decision and its `ExplanationRecord`. It identifies the reasoning path,
provider, model, endpoint, hashes of the exact request and response bytes,
cost basis, and verification or fallback outcome. It has no dedicated fields
for prompts, responses, credentials, chain-of-thought, or complete attestation
documents. Several identifier and reason fields are free-form strings, however,
so integrators must not place source content or secrets in them. The contract
cannot determine whether an arbitrary string contains sensitive content.

This first slice provides the contract, a repository create boundary that
requires caller-supplied recorder trust roots, owner-scoped read/delete
repository and API paths, backup/restore support, and a developer/library
verifier. No production composition root configures recorder keys or calls the
create boundary yet. Automatic receipt creation, a product export route, and
the receipt detail UI remain gated on the strict confidential-provider
integration. Until those land, absence of a receipt must be displayed as
unavailable and must never be inferred as a privacy outcome. The receipt enum
names are contract vocabulary, not a currently wired mapping from the Settings
reasoning selector.

## Independent verification

An export bundle contains the canonical signed receipt plus the exact request,
response, and (for confidential verification) minimum evidence bytes. The
product does not create or export this bundle in this slice: the receipt GET
route cannot be used as verifier input. Integrators and developers
can construct a bundle against the versioned library contract and run the
verifier from a built source checkout without starting the API or web UI:

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
as its own authority. There is no production caller or recorder-key
configuration in this slice. A `verified` confidential receipt additionally
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
and exact linkage before writing it. Because an embedded key is not an identity
trust root, restored rows are marked `imported_unverified`. This slice has no
trust-aware promotion workflow, so they remain untrusted after restore.
Standalone verification bundles are more sensitive because they contain the
exact supplied request and response bytes. The product does not emit those
bundles yet; integrators who create them should protect or delete the files
according to their own retention needs.

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
