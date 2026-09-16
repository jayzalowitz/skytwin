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

`verified_private_cloud` is available through the isolated TrustedRouter
adapter. NEAR AI is represented in Settings as **verification pending**, but it
is not admitted by this build. Providers are configured per user in
**Settings → AI brain**, and the first-run screen links directly to that setup.
Entering an API key, selecting HTTPS, or trusting a provider name still does
**not** establish confidentiality. A route is admitted only when its dedicated
SkyTwin adapter verifies evidence for the exact prompt connection and response.

The adapter contract is deliberately stronger than a conventional
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

SkyTwin pins the reviewed TrustedRouter JavaScript verifier source at commit
`2aa1d1c36b758eb65caf6c931e58a82bc0dc53eb`; the dependency has no native
runtime component. For every call, the adapter:

1. constructs policy from the workload image digest and image reference pinned
   in this SkyTwin build, then opens a TLS 1.3 session;
2. verifies issuer, audience, accepted workload image, certificate, fresh
   nonce, and TLS exporter binding before prompt transmission;
3. captures another verified attestation over that same live socket, then sends
   the exact buffered request body on the socket with
   `provider.min_privacy: "confidential"`, `data_collection: "deny"`, and a
   fresh receipt nonce;
4. buffers the full response without exposing tokens downstream;
5. fetches the issuing instance's receipt-key attestation on the same socket
   and verifies the Ed25519 receipt, freshness, nonce, requested and selected
   model, exact request/response hashes, attestation chain, and
   `upstream.tier: "tee-verified"`; and
6. emits a verified inference trace containing the exact body bytes and an
   evidence bundle. Only then is response text returned.

The production endpoint is fixed in code; user-supplied TrustedRouter base URLs
are rejected. The provider is rejected in `on_device` and
`bring_your_own_provider`, while every other provider is rejected in
`verified_private_cloud`. Verification failure, authentication failure, model
removal, receipt mismatch, timeout, or socket closure therefore ends the path
without a conventional-provider retry. The live trust record is review input,
not a trust root that can widen an already-built SkyTwin binary.

A signed receipt alone is not a confidentiality proof; TrustedRouter explicitly
separates receipt integrity/origin from session privacy. SkyTwin requires both
the live TLS-bound gateway verification and the receipt's confidential upstream
tier. The upstream tier is an authenticated TrustedRouter claim; SkyTwin does
not independently re-attest a third-party model host outside the evidence
carried by that receipt.

Operational limits remain explicit:

- a user must supply a valid TrustedRouter key with available credits;
- dynamic route pricing is not yet persisted as an expiring exact price, so the
  existing hard-spend gate blocks this provider for unattended calls; it is
  available for explicit interactive calls and connection tests;
- no response is streamed before final verification; and
- remote verification does not move policy, credentials, durable twin state,
  action authorization, or execution authority out of SkyTwin.

Provider materials used by the adapter and its review:

- [TrustedRouter API and confidential-routing documentation](https://trustedrouter.com/docs)
- [TrustedRouter live trust record: attestation, accepted measurements, and signed release provenance](https://trust.trustedrouter.com/)
- [TrustedRouter signed-receipt format and limitations](https://trustedrouter.com/docs/receipts)

The trust portal publishes measurements and describes checking a fresh
attestation's issuer, audience, image digest, and TLS-certificate binding. Its
scope is the hosted gateway workload; it does not independently attest every
downstream model host. SkyTwin therefore also requires the signed receipt's
`tee-verified` upstream tier and hard confidential routing policy. That tier is
an authenticated TrustedRouter claim, not a second SkyTwin-run hardware
verifier for the selected model host.

## Boundary comparison

| Route | What SkyTwin can establish today | Per-call admission requirement | Availability in this build |
| --- | --- | --- | --- |
| **On this device** | A managed artifact can be digest-checked; an explicit local model is local-only but not artifact-verified. | Compatible runtime admission; no remote fallback. | Available when the selected local runtime/model can run. |
| **TrustedRouter remote route** | A fresh same-session gateway attestation, pinned workload policy, hard confidential routing floor, and nonce-bound exact-byte receipt with a TEE-verified upstream tier. | Valid credentials/credits and successful per-call verification. Dynamic price persistence is still required before unattended use. | Available for explicit interactive calls; fails closed. |
| **NEAR AI remote route** | The public evidence can authenticate a base CVM, TDX/GPU state, TLS binding, and response signature, but does not pin the model/proxy workload dynamically selected by the privileged compose manager. | A future policy must verify the compose-manager evidence and event log against a pinned inference workload state. | Unavailable; settings explain the missing proof and runtime admission fails closed. |

This is a comparison of evidence boundaries, not a statement that remote and
local execution are interchangeable. A remote route remains unavailable until
SkyTwin verifies the evidence for that exact call and fails closed otherwise.

### NEAR AI

NEAR AI publishes model-specific direct completion endpoints and verifier
tooling. SkyTwin contains a staged strict client and transport in
[`packages/near-confidential`](../packages/near-confidential), including
same-socket TLS, TDX/GPU evidence, and exact-byte signature checks. That work is
not enough to admit the provider.

The live attestation reviewed for this integration measures a base compose
environment containing a privileged compose manager. That manager has access
to the Docker socket, host PID namespace, `SYS_ADMIN`, and `SYS_PTRACE`, and its
event log shows model and proxy services being selected and replaced after the
measured base environment starts. Pinning the base compose hash therefore does
not pin the code that receives a prompt. The reviewed upstream verifier checks
the quote and bindings, but does not enforce a SkyTwin-owned policy over the
compose-manager attestation, action history, model image, and proxy image.

Accordingly:

- Settings shows NEAR AI as **verification pending** and does not let a user
  add it to the verified-private chain;
- API and database compatibility gates reject new or stored NEAR AI chains;
- the staged provider code cannot be reached through
  `verified_private_cloud`; and
- SkyTwin makes no current confidential-inference claim for NEAR AI.

Admission requires a reviewed, stable policy that binds the live
compose-manager evidence and event log to exact approved model/proxy images and
rejects later mutations. Until then, trusting provider documentation or a valid
base-CVM quote is not a substitute for verifying the inference workload.

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
| **Verified private cloud — TrustedRouter** | The exact call passed same-session gateway attestation and exact-byte confidential-route receipt verification before content was released. |
| **Verified private cloud — NEAR AI** | Not emitted in this build. NEAR AI remains unavailable until SkyTwin can pin and verify the dynamically selected inference workload. |
| **Unavailable — no prompt sent** | A requested local or confidential boundary could not be admitted before transmission. No remote fallback is attempted. A post-transmission receipt failure also returns no content. |
| **My configured provider** | A separately selected conventional provider may receive prompts under its own terms. This is not confidential inference. |

This document describes runtime admission boundaries. It does not change the
separate storage, connector, or release-evidence limits described in
[the privacy policy](./privacy.html) and
[the beta claim ledger](./beta-claim-ledger.json). It describes SkyTwin's
integration state, not a claim that an external service has been independently
certified by this project.
