# Private inference boundaries

SkyTwin defaults to the **On this device** reasoning boundary. It is a policy
boundary, not a promise that a local model is already running. The managed
local-model setup requires a digest-verified model artifact and compatible
`llama.cpp` runtime; the Settings action **Set up local model** is the supported
first step. A failed download, digest check, runtime probe, or model launch
leaves that managed setup unavailable. An explicitly configured local model can
still run only on the device, but SkyTwin does not represent that user-managed
path as artifact-verified. Neither path falls back to a remote provider.

## Remote attested inference

`verified_private_cloud` is intentionally unavailable in this build. Entering
an API key, selecting HTTPS, or trusting a provider name does **not** enable it
and does not send a prompt. SkyTwin will expose a remote route as verified only
after its own adapter verifies the provider's evidence for the exact prompt
connection and exact response.

The planned adapter contract is deliberately stronger than a conventional
OpenAI-compatible endpoint:

- construct and retain the exact request bytes;
- verify fresh, policy-pinned attestation on the same live TLS connection that
  carries those bytes;
- refuse a route whose model, endpoint, measurement, nonce, certificate/key
  binding, or attestation age differs from policy;
- verify a nonce-bound receipt over the exact request and response bytes before
  returning content; and
- fail closed as **Unavailable — no prompt sent**. It must never retry through
  a conventional provider.

### TrustedRouter

TrustedRouter documents a confidential routing floor via
`provider.min_privacy: "confidential"`, signed inference receipts, and a
TLS-bound gateway-attestation procedure. A future SkyTwin adapter must require
that routing floor, verify the live attestation and policy, and then verify the
receipt's nonce, exact request/response hashes, selected route, attestation
chain, and freshness. A signed receipt alone is not a confidentiality proof;
TrustedRouter explicitly separates receipt integrity/origin from session
privacy. Use the provider materials to evaluate the route, not as a SkyTwin
availability claim:

- [TrustedRouter API and confidential-routing documentation](https://trustedrouter.com/docs)
- [TrustedRouter live trust record: attestation, accepted measurements, and signed release provenance](https://trust.trustedrouter.com/)
- [TrustedRouter signed-receipt format and limitations](https://trustedrouter.com/docs/receipts)

The trust portal is especially relevant to a future adapter: it publishes the
accepted measurements and describes checking a fresh attestation's issuer,
audience, image digest, and TLS-certificate binding. Its scope is the hosted
gateway workload; it does not turn every downstream model route into an
attested model-provider claim. In particular, the portal describes
user-provided-model routes as leaving that gateway boundary. SkyTwin must keep
those distinctions in its route policy rather than inferring them from a model
name. The portal also distinguishes a measured image from mutable launch-time
configuration; a future adapter must pin the full policy it relies on.

## Boundary comparison

| Route | What SkyTwin can establish today | What a future remote adapter must establish | Availability in this build |
| --- | --- | --- | --- |
| **On this device** | A managed artifact can be digest-checked; an explicit local model is local-only but not artifact-verified. | Compatible runtime admission; no remote fallback. | Available when the selected local runtime/model can run. |
| **TrustedRouter remote route** | The provider publishes a trust portal, a confidential-routing floor, attestation material, and receipts. | A fresh TLS-bound gateway attestation against an accepted measurement, the required route policy, and a nonce-bound exact-byte receipt. | Unavailable — SkyTwin has not yet wired a verifier-owned transport. |
| **NEAR AI remote route** | A fail-closed client contract exists, and the provider publishes verifier tooling and direct-endpoint attestation material. | A packaged pinned verifier, fresh endpoint policy, TLS/TEE evidence, stable completion-to-signature routing, and response-signature checks. | Unavailable — SkyTwin has not yet wired a production verifier-owned transport. |

This is a comparison of evidence boundaries, not a statement that remote and
local execution are interchangeable. A remote route remains unavailable until
SkyTwin verifies the evidence for that exact call and fails closed otherwise.

### NEAR AI

NEAR AI publishes verifier tooling for direct confidential endpoints. SkyTwin's
`@skytwin/near-confidential` package implements the fail-closed client contract,
but it is not an available inference provider. The contract requires all of the
following before prompt bytes may be sent:

- the model remains present in a live catalog and is marked verifiable,
  attestation-supported, and compatible with the serving protocol;
- the selected URL is that model's HTTPS direct endpoint under
  `completions.near.ai`, rather than the shared gateway;
- a client-generated 32-byte nonce is bound into verified TDX and GPU evidence;
- verified `report_data` binds the attested signing identity and live TLS SPKI
  fingerprint to that nonce, alongside the approved deployment measurement;
- TLS attestation is checked on the same live connection that will carry the
  prompt.

The client snapshots transport and channel method capabilities before any later
asynchronous boundary. Every catalog, channel-open, send, signature,
verification, and close stage has a bounded deadline and receives an abort
signal. Fixed catalog, string, request, response, signature, and attestation
proof limits are passed to the transport and independently enforced at the
client boundary. A production transport must apply those limits while reading
from the network, before allocating an unbounded response body.

After inference, the same channel retrieves `GET /v1/signature/{chat_id}`. The
verifier must normalize the response by binding model/chat identity, signature
scheme, signed-text format, and provenance to authenticated channel and route
facts. It must authenticate provenance (`provider_tee`, not `gateway`) before
the prompt is sent and must never infer it from caller input or stamp a trusted
default. The normalized record must match the attested channel. The verifier
receives immutable snapshots of the exact request and response bytes and checks
the current proxy's domain-separated
`model:SHA256(request):SHA256(response)` signed text using EIP-191 or Ed25519
without parsing and reserializing JSON. Failed verification returns no response
content and never falls back to a conventional cloud provider.

The ordinary OpenAI-compatible adapter uses platform `fetch`, which cannot
expose the live peer certificate or prove that preflight attestation and the
inference POST share one connection. Enabling NEAR therefore requires a
packaged, independently reviewed transport backed by a pinned verifier.
Upstream verifier issue
[#33](https://github.com/nearai/nearai-cloud-verifier/issues/33) also tracks
cases where direct signature lookup can reach a route without the completion's
cached record, so the production adapter must demonstrate stable
completion-to-signature routing. Until those prerequisites exist,
`UnavailableConfidentialTransport` fails before transmitting prompts.

Provider materials:

- [NEAR AI private-inference architecture](https://docs.near.ai/cloud/private-inference)
- [NEAR AI verification guide](https://docs.near.ai/cloud/verification)
- [NEAR AI TLS attestation guide](https://docs.near.ai/cloud/verification/tls)
- [NEAR AI Cloud Verifier](https://github.com/nearai/nearai-cloud-verifier)
- [NEAR AI private chat API and attestation endpoint](https://github.com/nearai/chat-api)

## What your status means

| Status | Meaning |
| --- | --- |
| **On this device — managed artifact verified** | A digest-verified managed artifact and compatible runtime were admitted for a local-only call. |
| **On this device — user-managed model** | A configured local model was admitted only to the local boundary; SkyTwin does not claim artifact verification for it. |
| **Unavailable — no prompt sent** | A requested local or confidential boundary could not be verified. No remote fallback is attempted. |
| **My configured provider** | A separately selected conventional provider may receive prompts under its own terms. This is not confidential inference. |

This document describes runtime admission boundaries. It does not change the
separate storage, connector, or release-evidence limits described in
[the privacy policy](./privacy.html) and
[the beta claim ledger](./beta-claim-ledger.json). It describes SkyTwin's
integration state, not a claim that an external service has been independently
certified by this project.
