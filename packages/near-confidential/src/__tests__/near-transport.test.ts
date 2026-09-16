import { describe, expect, it, vi } from "vitest";
import {
  CONFIDENTIAL_RESOURCE_LIMITS,
  NearConfidentialTransport,
  NEAR_VERIFIER_VERSION,
} from "../index.js";
import type { AttestationPolicy, ConfidentialOperationContext } from "../types.js";

const context: ConfidentialOperationContext = {
  signal: new AbortController().signal,
  timeoutMs: 1_000,
  limits: CONFIDENTIAL_RESOURCE_LIMITS,
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("NearConfidentialTransport", () => {
  it("discovers only canonical model-specific direct endpoints", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      endpoints: [
        {
          domain: "dsv4-flash.completions.near.ai",
          models: ["deepseek-ai/DeepSeek-V4-Flash"],
        },
        { domain: "evil.example", models: ["untrusted"] },
      ],
    }));
    const transport = new NearConfidentialTransport({
      apiKey: "near-key",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(transport.discoverModels(context)).resolves.toEqual([{
      id: "deepseek-ai/DeepSeek-V4-Flash",
      directEndpoint: "https://dsv4-flash.completions.near.ai/v1",
      verifiable: true,
      attestationSupported: true,
      vllmCompatible: true,
    }]);
  });

  it("rejects non-canonical endpoints before opening a socket", async () => {
    const transport = new NearConfidentialTransport({ apiKey: "near-key" });
    const policy: AttestationPolicy = {
      modelId: "deepseek-ai/DeepSeek-V4-Flash",
      directEndpoint: "https://cloud-api.near.ai/v1",
      approvedMeasurements: ["a".repeat(64)],
      maxAgeMs: 60_000,
      verifierVersion: NEAR_VERIFIER_VERSION,
      signatureAlgorithm: "ed25519",
      signatureProvenance: "provider_tee",
    };

    await expect(transport.openVerifiedChannel({
      policy,
      nonce: new Uint8Array(32),
    }, context)).resolves.toMatchObject({
      ok: false,
      code: "endpoint_ineligible",
      promptTransmitted: false,
    });
  });

  it("fails closed on malformed or oversized catalogs", async () => {
    const malformed = new NearConfidentialTransport({
      apiKey: "near-key",
      fetchImpl: vi.fn(async () => jsonResponse({ endpoints: "not-an-array" })) as typeof fetch,
    });
    await expect(malformed.discoverModels(context)).rejects.toThrow("malformed");

    const oversized = new NearConfidentialTransport({
      apiKey: "near-key",
      fetchImpl: vi.fn(async () => new Response("x".repeat(300 * 1024))) as typeof fetch,
    });
    await expect(oversized.discoverModels(context)).rejects.toThrow("byte limit");
  });
});
