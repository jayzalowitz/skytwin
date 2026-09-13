# Confidential inference integration status

SkyTwin has a fail-closed contract for strict confidential inference in
`@skytwin/near-confidential`. It is not yet an available inference provider.

The contract requires all of the following before prompt bytes may be sent:

- the model remains present in a live catalog and is marked verifiable,
  attestation-supported, and compatible with the serving protocol;
- the selected URL is that model's HTTPS direct endpoint under
  `completions.near.ai`, rather than the shared gateway;
- a client-generated 32-byte nonce is bound into verified TDX and GPU evidence;
- verified `report_data` binds the attested signing identity and live TLS SPKI
  fingerprint to that nonce, alongside the approved deployment measurement;
- TLS attestation is checked on the same live connection that will carry the
  prompt.

After inference, the same channel retrieves `GET /v1/signature/{chat_id}`. The
raw endpoint currently returns `text`, `signature`, `signing_address`, and
`signing_algo`; it does not return model/chat identity, signature scheme, signed
text format, or provenance. The verifier must normalize that response by binding
those additional fields to authenticated channel and route facts. In particular,
it must authenticate provenance (`provider_tee`, not `gateway`) before the prompt
is sent and must never infer it from caller input or stamp a trusted default.
The normalized record must match the attested channel. The channel verifier
receives immutable snapshots of the exact request and response
bytes. It requires the current proxy's domain-separated
`model:SHA256(request):SHA256(response)` signed text and validates the EIP-191
or Ed25519 signature without parsing and reserializing JSON. A failed
verification returns no response content and there
is no conventional cloud-provider fallback.

## Why the provider is not enabled yet

The repository's ordinary OpenAI-compatible adapter uses the platform `fetch`
API. That API does not expose the live peer certificate or guarantee that a
preflight attestation check and a later POST reuse one connection. Treating that
path as verified confidential inference would therefore be inaccurate.

Enabling the provider requires a packaged transport backed by a pinned,
independently reviewed verifier that can keep attestation and inference on one
TLS connection; validate TDX, NVIDIA, nonce, `report_data`, SPKI, deployment
measurement, and signer bindings; and retrieve and validate the direct model's
signature record deterministically. Upstream verifier issue
[#33](https://github.com/nearai/nearai-cloud-verifier/issues/33) currently tracks
cases where direct signature lookup can reach a route that does not hold the
completion's cached record, so a production adapter must demonstrate stable
completion-to-signature routing rather than treating a retrying lookup as a
security proof. That transport does not exist in this repository. It also
requires live endpoint access and credentials/credits to exercise the protocol.
Until those prerequisites are present, `UnavailableConfidentialTransport`
fails before transmitting prompts.

The protocol assumptions above are sourced from the official
[private-inference architecture](https://docs.near.ai/cloud/private-inference),
[verification guide](https://docs.near.ai/cloud/verification),
[TLS attestation guide](https://docs.near.ai/cloud/verification/tls), and
[reference verifier](https://github.com/nearai/nearai-cloud-verifier). This page
describes SkyTwin's integration state, not a claim that the external service has
been independently certified by this project.
