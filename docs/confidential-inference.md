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
- [TrustedRouter attestation procedure](https://trustedrouter.com/trust)
- [TrustedRouter signed-receipt format and limitations](https://trustedrouter.com/docs/receipts)

### NEAR AI

NEAR AI publishes verifier tooling for direct confidential endpoints. A future
SkyTwin adapter must use a pinned verifier and direct endpoint policy to verify
the fresh nonce, TDX and GPU evidence, measurement, report-data signer, and TLS
binding before it sends prompt data, then verify the exact response signature
before returning response content. The generic HTTP client cannot establish this
boundary because it cannot prove that a preflight attestation and a later
inference request use the same TLS connection. Provider materials:

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
[the beta claim ledger](./beta-claim-ledger.json).
